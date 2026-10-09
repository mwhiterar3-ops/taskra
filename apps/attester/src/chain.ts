// The attestation service's view of Solana. Besides reads it can do exactly one
// thing: broadcast bytes that the signer produced.

import { Connection, type PublicKey } from '@solana/web3.js';
import {
  type AccountReader,
  fetchChainTime,
  fetchPlatform,
  fetchTask,
  type TaskAccount,
  type TaskraCommitment,
  type TaskraConfig,
} from '@taskra/sdk';

export interface TaskRead {
  readonly account: TaskAccount;
  readonly slot: number;
}

export interface SignatureState {
  readonly finalized: boolean;
  /** The cluster's TransactionError, or `null` if the transaction succeeded. */
  readonly error: unknown;
}

export interface AttesterChain {
  getTask(address: PublicKey, commitment: TaskraCommitment): Promise<TaskRead | null>;
  getChainTime(commitment: TaskraCommitment): Promise<bigint>;
  /** The attester recorded in the Platform account, at finalized. */
  getPlatformAttester(): Promise<PublicKey>;
  getLatestBlockhash(): Promise<string>;
  /** Broadcasts a signed transaction. Resolves once the RPC node accepted it. */
  sendTransaction(serialized: Uint8Array): Promise<void>;
  /** `null` when the cluster does not know the signature. */
  getSignatureState(signature: string): Promise<SignatureState | null>;
}

export function createAttesterChain(
  rpcUrl: string,
  config: TaskraConfig,
  timeoutMs = 10_000,
): AttesterChain {
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  const reader: AccountReader = {
    getAccountInfo: (address, commitment) => connection.getAccountInfo(address, commitment),
  };

  return {
    async getTask(address, commitment) {
      let slot = 0;
      const slotReader: AccountReader = {
        getAccountInfo: async (target, level) => {
          const response = await connection.getAccountInfoAndContext(target, level);
          slot = response.context.slot;
          return response.value;
        },
      };
      const account = await fetchTask(slotReader, config, address, commitment);
      return account === null ? null : { account, slot };
    },
    getChainTime: (commitment) => fetchChainTime(reader, commitment),
    getPlatformAttester: async () => (await fetchPlatform(reader, config, 'finalized')).attester,
    getLatestBlockhash: async () => (await connection.getLatestBlockhash('confirmed')).blockhash,
    async sendTransaction(serialized) {
      // Preflight simulates against confirmed state, so a transaction the
      // program would refuse is reported here instead of being broadcast.
      await connection.sendRawTransaction(serialized, { preflightCommitment: 'confirmed' });
    },
    async getSignatureState(signature) {
      const response = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = response.value[0];
      if (status === null || status === undefined) return null;
      return { finalized: status.confirmationStatus === 'finalized', error: status.err };
    },
  };
}
