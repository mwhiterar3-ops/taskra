// Turns a transaction fetched from the API's own RPC endpoint into the Taskra
// instructions it carries for a task. Nothing here comes from a request body: the
// instruction name, its accounts and its arguments are all read from the chain
// (docs/14-API-CONTRACT.md §3).

import { IDL, type InstructionName } from '@taskra/sdk';

/** An instruction invoked by a top-level instruction (a cross-program call). */
export interface InnerInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export interface ObservedInstruction extends InnerInstruction {
  /**
   * Every instruction this one invoked, in execution order. `null` when the
   * RPC endpoint did not report inner instructions at all, which is different
   * from reporting that there were none.
   */
  readonly inner: readonly InnerInstruction[] | null;
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
}

export interface TaskraInstruction {
  readonly name: InstructionName;
  /** By IDL account name. `null` marks an optional account that was omitted. */
  readonly accounts: Readonly<Record<string, string | null>>;
  /** Argument bytes, after the 8-byte discriminator. */
  readonly args: Uint8Array;
  /** What this instruction itself invoked. See `ObservedInstruction.inner`. */
  readonly inner: readonly InnerInstruction[] | null;
}

/** Why a transaction is not the Taskra transaction a caller said it was. */
export class TransactionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionMismatchError';
  }
}

/** Why a finalized outcome transaction cannot be turned into a settlement record. */
export class SettlementEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementEvidenceError';
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
    inner: instruction.inner,
  };
}

/**
 * Every top-level Taskra instruction of `transaction` that names `task` as its
 * Task account, in order.
 *
 * A transaction may call the program any number of times, for any number of
 * tasks: whoever sends it decides that. Instructions for other tasks are not
 * this task's business and are skipped, so nobody can hide a task's instruction
 * by putting another one next to it. A Taskra instruction this API cannot
 * decode is skipped as well, unless nothing else is left to report.
 */
export function taskInstructions(
  transaction: ObservedTransaction,
  programId: string,
  task: string,
): TaskraInstruction[] {
  const calls = transaction.instructions.filter(
    (instruction) => instruction.programId === programId,
  );
  if (calls.length === 0) {
    throw new TransactionMismatchError('the transaction does not call the Taskra program');
  }
  const found: TaskraInstruction[] = [];
  let undecodable: TransactionMismatchError | undefined;
  for (const call of calls) {
    try {
      const decoded = decode(call, programId);
      if (decoded.accounts['task'] === task) found.push(decoded);
    } catch (error) {
      if (!(error instanceof TransactionMismatchError)) throw error;
      undecodable ??= error;
    }
  }
  if (found.length === 0 && undecodable !== undefined) throw undecodable;
  return found;
}

/**
 * The one top-level Taskra instruction of `transaction` for `task`: what a
 * report of a signature describes. None, or more than one for the same task,
 * is refused.
 */
export function findTaskInstruction(
  transaction: ObservedTransaction,
  programId: string,
  task: string,
): TaskraInstruction {
  const found = taskInstructions(transaction, programId, task);
  const [only] = found;
  if (only === undefined) {
    throw new TransactionMismatchError('the transaction is for a different task');
  }
  if (found.length > 1) {
    throw new TransactionMismatchError(
      'the transaction has more than one Taskra instruction for this task',
    );
  }
  return only;
}

/**
 * Whether another program invoked a Taskra outcome instruction for `task` in
 * this transaction (a wrapper call), as far as the reported inner instructions
 * show. Such a settlement is real on-chain, but this API does not record it:
 * see `recordSettlement`.
 */
export function outcomeInvokedByAnotherProgram(
  transaction: ObservedTransaction,
  programId: string,
  task: string,
): boolean {
  return transaction.instructions.some(
    (instruction) =>
      instruction.programId !== programId &&
      (instruction.inner ?? []).some((inner) => {
        if (inner.programId !== programId) return false;
        try {
          const decoded = decode({ ...inner, inner: null }, programId);
          return OUTCOME_INSTRUCTIONS.includes(decoded.name) && decoded.accounts['task'] === task;
        } catch (error) {
          if (error instanceof TransactionMismatchError) return false;
          throw error;
        }
      }),
  );
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

// SPL Token instruction tags.
const TOKEN_TRANSFER = 3;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_TRANSFER_CHECKED = 12;

export interface EscrowAddresses {
  /** The SPL Token program. */
  readonly tokenProgram: string;
  /** The task's escrow token account. */
  readonly escrow: string;
  /** The Task PDA, which is the escrow's only authority. */
  readonly task: string;
  readonly mint: string;
}

export interface EscrowMovements {
  /** Amount sent from the escrow to each destination token account, by this instruction. */
  readonly transfers: ReadonlyMap<string, bigint>;
  /** Whether this instruction closed the escrow account. */
  readonly closed: boolean;
}

/**
 * What a Taskra instruction itself did to the task's escrow: the token
 * transfers it made out of it and whether it closed it.
 *
 * Only the instruction's own inner instructions are read. Anything else in the
 * transaction (other top-level instructions, their inner instructions, balance
 * changes of any account) is ignored, so nobody can change what is recorded for
 * a settlement by adding transfers of their own to the same transaction. A
 * transfer out of the escrow can only be signed by the Task PDA, and only the
 * Taskra program can sign for that.
 */
export function escrowMovements(
  instruction: TaskraInstruction,
  expected: EscrowAddresses,
): EscrowMovements {
  if (instruction.inner === null) {
    throw new SettlementEvidenceError('the RPC endpoint did not report inner instructions');
  }
  const transfers = new Map<string, bigint>();
  let closed = false;
  for (const inner of instruction.inner) {
    if (inner.programId !== expected.tokenProgram || inner.accounts[0] !== expected.escrow) {
      continue;
    }
    const tag = inner.data[0];
    if (tag === TOKEN_TRANSFER_CHECKED) {
      const [, mint, destination, authority] = inner.accounts;
      if (
        inner.data.length !== 10 ||
        destination === undefined ||
        mint !== expected.mint ||
        authority !== expected.task
      ) {
        throw new SettlementEvidenceError('a transfer out of the escrow is not the expected one');
      }
      const amount = new DataView(
        inner.data.buffer,
        inner.data.byteOffset,
        inner.data.byteLength,
      ).getBigUint64(1, true);
      transfers.set(destination, (transfers.get(destination) ?? 0n) + amount);
    } else if (tag === TOKEN_CLOSE_ACCOUNT) {
      if (inner.accounts[2] !== expected.task) {
        throw new SettlementEvidenceError('the escrow was closed by an unexpected authority');
      }
      closed = true;
    } else if (tag === TOKEN_TRANSFER) {
      // The program only ever uses TransferChecked on the escrow.
      throw new SettlementEvidenceError('an unexpected kind of transfer left the escrow');
    }
  }
  return { transfers, closed };
}
