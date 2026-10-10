// The API's only view of Solana: read-only, through its own RPC endpoint.
// There is no method here that sends a transaction.

import { Connection, type PublicKey } from '@solana/web3.js';
import {
  type AccountReader,
  fetchChainTime,
  fetchPlatform,
  fetchTask,
  type PlatformAccount,
  type TaskAccount,
  type TaskraCommitment,
  type TaskraConfig,
  TaskraSdkError,
} from '@taskra/sdk';
import bs58 from 'bs58';
import type { InnerInstruction, ObservedTransaction } from './parse.js';

export interface TaskSnapshot {
  readonly account: TaskAccount;
  /** The slot the account was read at. */
  readonly slot: number;
  readonly commitment: TaskraCommitment;
}

export interface SignatureStatus {
  readonly slot: number;
  readonly finalized: boolean;
  readonly failed: boolean;
}

export interface ChainReader {
  /** The Task account at `address`, or `null` if it does not exist at this commitment. */
  getTask(address: PublicKey, commitment: TaskraCommitment): Promise<TaskSnapshot | null>;
  getPlatform(commitment: TaskraCommitment): Promise<PlatformAccount>;
  getChainTime(commitment: TaskraCommitment): Promise<bigint>;
  /** `null` when the cluster does not know the transaction at this commitment. */
  getTransaction(
    signature: string,
    commitment: TaskraCommitment,
  ): Promise<ObservedTransaction | null>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  /** Finalized signatures that reference `address`, newest first. */
  findFinalizedSignatures(address: PublicKey, limit: number): Promise<string[]>;
  /** Resolves when the RPC endpoint answers; rejects otherwise. */
  ping(): Promise<void>;
}

/** The RPC endpoint failed, timed out or returned something unusable. */
export class ChainUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Solana RPC ${operation} failed`, { cause });
    this.name = 'ChainUnavailableError';
  }
}

export interface RpcPolicy {
  /** Per-request timeout. */
  readonly timeoutMs: number;
  /** Delays before each retry of a failed read. */
  readonly retryDelaysMs: readonly number[];
}

export const DEFAULT_RPC_POLICY: RpcPolicy = { timeoutMs: 10_000, retryDelaysMs: [250, 1_000] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries idempotent reads; an SDK decoding error is a fact, not an outage, and is rethrown. */
export async function withRetry<Result>(
  operation: string,
  policy: RpcPolicy,
  read: () => Promise<Result>,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.retryDelaysMs.length; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof TaskraSdkError) throw error;
      lastError = error;
      const delay = policy.retryDelaysMs[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw new ChainUnavailableError(operation, lastError);
}

export function createChainReader(
  rpcUrl: string,
  config: TaskraConfig,
  policy: RpcPolicy = DEFAULT_RPC_POLICY,
): ChainReader {
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    // Retries and timeouts are this module's policy, not the library's.
    disableRetryOnRateLimit: true,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) }),
  });
  const reader: AccountReader = {
    getAccountInfo: (address, commitment) => connection.getAccountInfo(address, commitment),
  };

  return {
    getTask: (address, commitment) =>
      withRetry('getAccountInfo', policy, async () => {
        let slot = 0;
        const slotReader: AccountReader = {
          getAccountInfo: async (target, level) => {
            const response = await connection.getAccountInfoAndContext(target, level);
            slot = response.context.slot;
            return response.value;
          },
        };
        const account = await fetchTask(slotReader, config, address, commitment);
        return account === null ? null : { account, slot, commitment };
      }),

    getPlatform: (commitment) =>
      withRetry('getAccountInfo', policy, () => fetchPlatform(reader, config, commitment)),

    getChainTime: (commitment) =>
      withRetry('getAccountInfo', policy, () => fetchChainTime(reader, commitment)),

    getTransaction: (signature, commitment) =>
      withRetry('getTransaction', policy, async () => {
        const response = await connection.getTransaction(signature, {
          commitment,
          maxSupportedTransactionVersion: 0,
        });
        if (response === null) return null;
        const { meta, transaction } = response;
        if (meta === null) throw new Error('the RPC endpoint returned a transaction without meta');

        const keys = transaction.message.getAccountKeys({
          accountKeysFromLookups: meta.loadedAddresses ?? { writable: [], readonly: [] },
        });
        const address = (index: number): string => {
          const key = keys.get(index);
          if (key === undefined) throw new Error('transaction references an unknown account');
          return key.toBase58();
        };

        // Inner instructions, by the index of the top-level instruction that
        // made them. A node that does not report them leaves every list null.
        const reported = meta.innerInstructions;
        const innerOf = (index: number): InnerInstruction[] | null =>
          reported == null
            ? null
            : reported
                .filter((entry) => entry.index === index)
                .flatMap((entry) => entry.instructions)
                .map((instruction) => ({
                  programId: address(instruction.programIdIndex),
                  accounts: instruction.accounts.map(address),
                  data: bs58.decode(instruction.data),
                }));

        return {
          signature,
          slot: response.slot,
          blockTime: response.blockTime ?? null,
          error: meta.err,
          instructions: transaction.message.compiledInstructions.map((instruction, index) => ({
            programId: address(instruction.programIdIndex),
            accounts: instruction.accountKeyIndexes.map(address),
            data: instruction.data,
            inner: innerOf(index),
          })),
        };
      }),

    getSignatureStatus: (signature) =>
      withRetry('getSignatureStatuses', policy, async () => {
        const response = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = response.value[0];
        if (status === null || status === undefined) return null;
        return {
          slot: status.slot,
          finalized: status.confirmationStatus === 'finalized',
          failed: status.err !== null,
        };
      }),

    findFinalizedSignatures: (address, limit) =>
      withRetry('getSignaturesForAddress', policy, async () => {
        const entries = await connection.getSignaturesForAddress(address, { limit }, 'finalized');
        return entries.map((entry) => entry.signature);
      }),

    ping: () =>
      withRetry('getSlot', { ...policy, retryDelaysMs: [] }, async () => {
        await connection.getSlot('confirmed');
      }),
  };
}
