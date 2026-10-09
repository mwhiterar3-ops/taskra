// Turns a transaction fetched from the API's own RPC endpoint into the one
// Taskra instruction it carries. Nothing here comes from a request body: the
// instruction name, its accounts and its arguments are all read from the chain
// (docs/14-API-CONTRACT.md §3).

import { IDL, type InstructionName } from '@taskra/sdk';

export interface ObservedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export interface TokenBalanceChange {
  /** Address of the token account. */
  readonly account: string;
  readonly mint: string;
  readonly pre: bigint;
  readonly post: bigint;
}

/** A transaction as the chain reports it, reduced to what Taskra inspects. */
export interface ObservedTransaction {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds, when the cluster reports it. */
  readonly blockTime: number | null;
  /** `null` when the transaction succeeded; otherwise the cluster's TransactionError. */
  readonly error: unknown;
  /** Top-level instructions only, in order. */
  readonly instructions: readonly ObservedInstruction[];
  readonly tokenBalances: readonly TokenBalanceChange[];
}

export interface TaskraInstruction {
  readonly name: InstructionName;
  /** By IDL account name. `null` marks an optional account that was omitted. */
  readonly accounts: Readonly<Record<string, string | null>>;
  /** Argument bytes, after the 8-byte discriminator. */
  readonly args: Uint8Array;
}

/** Why a transaction is not the Taskra transaction a caller said it was. */
export class TransactionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionMismatchError';
  }
}

const DISCRIMINATOR_LENGTH = 8;

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function decode(instruction: ObservedInstruction, programId: string): TaskraInstruction {
  const definition = IDL.instructions.find((candidate) =>
    startsWith(instruction.data, candidate.discriminator),
  );
  if (definition === undefined) {
    throw new TransactionMismatchError('the transaction calls an unknown Taskra instruction');
  }
  if (instruction.accounts.length < definition.accounts.length) {
    throw new TransactionMismatchError('the Taskra instruction is missing accounts');
  }
  const accounts: Record<string, string | null> = {};
  definition.accounts.forEach((meta, index) => {
    const address = instruction.accounts[index] ?? null;
    // Anchor encodes an omitted optional account as the program id.
    const optional = 'optional' in meta && meta.optional;
    accounts[meta.name] = optional && address === programId ? null : address;
  });
  return {
    name: definition.name,
    accounts,
    args: instruction.data.subarray(DISCRIMINATOR_LENGTH),
  };
}

/**
 * The single top-level Taskra instruction of `transaction`.
 *
 * A transaction with no Taskra instruction, or with more than one, is refused:
 * one report must describe one transition of one task.
 */
export function findTaskraInstruction(
  transaction: ObservedTransaction,
  programId: string,
): TaskraInstruction {
  const matching = transaction.instructions.filter(
    (instruction) => instruction.programId === programId,
  );
  const [only] = matching;
  if (only === undefined) {
    throw new TransactionMismatchError('the transaction does not call the Taskra program');
  }
  if (matching.length > 1) {
    throw new TransactionMismatchError('the transaction calls the Taskra program more than once');
  }
  return decode(only, programId);
}

const HASH_ARGUMENT: readonly InstructionName[] = ['submit_work', 'approve_task', 'reject_task'];

/** The 32-byte hash argument of `submit_work`, `approve_task` or `reject_task`. */
export function hashArgument(instruction: TaskraInstruction): Uint8Array {
  if (!HASH_ARGUMENT.includes(instruction.name) || instruction.args.length !== 32) {
    throw new TransactionMismatchError(`${instruction.name} does not carry a single hash`);
  }
  return instruction.args;
}

/** Instructions that move the escrow out and write a terminal state. */
export const OUTCOME_INSTRUCTIONS: readonly InstructionName[] = [
  'cancel_task',
  'refund_expired',
  'approve_task',
  'expire_review',
  'resolve_dispute',
  'expire_dispute',
];

/** `post - pre` for one token account in this transaction (0 if it did not change). */
export function tokenDelta(transaction: ObservedTransaction, account: string | null): bigint {
  if (account === null) return 0n;
  const change = transaction.tokenBalances.find((balance) => balance.account === account);
  return change === undefined ? 0n : change.post - change.pre;
}
