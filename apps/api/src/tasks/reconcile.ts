// Brings the database's copy of a task in line with Solana. The chain is read
// through the API's own RPC endpoint; nothing a client says is trusted here.
//
//   confirmed read  -> refreshes the display cache (tasks.chain_*)
//   finalized read  -> the only source of a settlement row
//
// docs/14-API-CONTRACT.md §3, §5 and §7.

import { PublicKey } from '@solana/web3.js';
import {
  computeFee,
  decodeProgramError,
  findEscrowAddress,
  type InstructionName,
  isTerminalState,
  type TaskAccount,
  type TaskraCommitment,
  type TaskState,
  termsMatchTask,
  uuidFromTaskId,
} from '@taskra/sdk';
import { type Queryable, withTransaction } from '@taskra/shared/db';
import {
  findTaskraInstruction,
  type ObservedTransaction,
  OUTCOME_INSTRUCTIONS,
  type TaskraInstruction,
  tokenDelta,
  TransactionMismatchError,
} from '../chain/parse.js';
import { ChainUnavailableError, type TaskSnapshot } from '../chain/reader.js';
import type { AppDeps } from '../deps.js';
import { ApiError, conflict } from '../errors.js';

export interface TaskRow {
  readonly id: string;
  readonly client_wallet: string;
  readonly task_address: string;
  readonly title: string;
  readonly description: string;
  readonly repo: string;
  readonly acceptance_criteria: string;
  readonly work_duration: string;
  readonly amount: string;
  readonly terms_hash: string;
  readonly created_at: Date;
  readonly chain_state: TaskState | null;
  readonly chain_outcome: string | null;
  readonly chain_developer: string | null;
  readonly chain_terms_match: boolean | null;
  readonly chain_slot: string | null;
  readonly chain_commitment: TaskraCommitment | null;
  readonly chain_synced_at: Date | null;
}

export type TransactionStatus = 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'DROPPED';

/** A confirmed-only observation older than this, which the cluster no longer knows, was dropped. */
const DROPPED_AFTER_MS = 3 * 60 * 1000;
const SETTLEMENT_SEARCH_LIMIT = 25;

/**
 * Whether the on-chain task is the one this metadata describes. The hash is
 * recomputed from the stored metadata; the stored `terms_hash` column is not
 * trusted for this.
 */
export function termsMatch(row: TaskRow, account: TaskAccount): boolean {
  return termsMatchTask(
    {
      repo: row.repo,
      acceptanceCriteria: row.acceptance_criteria,
      workDuration: BigInt(row.work_duration),
      amount: BigInt(row.amount),
    },
    account,
  );
}

function assertSameTask(row: TaskRow, account: TaskAccount): void {
  // Guaranteed by the PDA seeds; checked so a wrong account can never be cached.
  if (
    account.client.toBase58() !== row.client_wallet ||
    uuidFromTaskId(account.taskId) !== row.id
  ) {
    throw new Error(`account ${row.task_address} does not belong to task ${row.id}`);
  }
}

async function writeCache(
  db: Queryable,
  row: TaskRow,
  snapshot: TaskSnapshot | null,
  now: Date,
): Promise<TaskRow> {
  if (snapshot === null) {
    // No account at this commitment. A finalized observation cannot vanish, so
    // only a confirmed-only cache entry is cleared (a dropped fork).
    const cleared = await db.query<TaskRow>(
      `UPDATE tasks SET chain_state = NULL, chain_outcome = NULL, chain_developer = NULL,
              chain_terms_match = NULL, chain_slot = NULL, chain_commitment = NULL,
              chain_synced_at = $2
        WHERE id = $1 AND chain_commitment = 'confirmed'
      RETURNING *`,
      [row.id, now],
    );
    return cleared.rows[0] ?? row;
  }
  const { account } = snapshot;
  assertSameTask(row, account);
  // Never let an older read (a lagging RPC node) overwrite a newer one, never
  // let a confirmed read replace a finalized one at the same slot, and keep the
  // `finalized` label while the state it was given for is unchanged.
  const updated = await db.query<TaskRow>(
    `UPDATE tasks SET chain_state = $2, chain_outcome = $3, chain_developer = $4,
            chain_terms_match = $5, chain_slot = $6, chain_synced_at = $8,
            chain_commitment = CASE WHEN chain_commitment = 'finalized' AND chain_state = $2
                                    THEN 'finalized' ELSE $7 END
      WHERE id = $1
        AND (chain_slot IS NULL OR chain_slot < $6
             OR (chain_slot = $6 AND (chain_commitment = 'confirmed' OR $7 = 'finalized')))
    RETURNING *`,
    [
      row.id,
      account.state,
      account.outcome,
      account.developer?.toBase58() ?? null,
      termsMatch(row, account),
      snapshot.slot,
      snapshot.commitment,
      now,
    ],
  );
  return updated.rows[0] ?? row;
}

/** Promotes or retires this task's confirmed-only observations. */
async function settlePendingTransactions(deps: AppDeps, taskId: string): Promise<void> {
  const pending = await deps.pool.query<{ signature: string; first_seen_at: Date }>(
    `SELECT signature, first_seen_at FROM onchain_transactions
      WHERE task_id = $1 AND status = 'CONFIRMED'`,
    [taskId],
  );
  for (const { signature, first_seen_at: firstSeenAt } of pending.rows) {
    const status = await deps.chain.getSignatureStatus(signature);
    let next: TransactionStatus | null = null;
    if (status === null) {
      if (deps.now().getTime() - firstSeenAt.getTime() > DROPPED_AFTER_MS) next = 'DROPPED';
    } else if (status.failed) {
      next = 'FAILED';
    } else if (status.finalized) {
      next = 'FINALIZED';
    }
    if (next !== null) {
      await deps.pool.query(
        `UPDATE onchain_transactions SET status = $2, updated_at = $3
          WHERE signature = $1 AND status = 'CONFIRMED'`,
        [signature, next, deps.now()],
      );
    }
  }
}

interface ObservedAmounts {
  readonly fee: bigint;
  readonly developer: bigint;
  readonly client: bigint;
}

/**
 * The token movements of an outcome transaction, read from its balance changes.
 * They must add up to exactly what left escrow, or nothing is recorded.
 */
export function observedAmounts(
  transaction: ObservedTransaction,
  instruction: TaskraInstruction,
  account: TaskAccount,
  escrow: string,
): ObservedAmounts {
  const treasury = instruction.accounts['treasury'] ?? null;
  const developerToken = instruction.accounts['developer_token'] ?? null;
  const clientToken = instruction.accounts['client_token'] ?? null;

  let fee = tokenDelta(transaction, treasury);
  let developer = tokenDelta(transaction, developerToken);
  const client = tokenDelta(transaction, clientToken);
  if (treasury !== null && treasury === developerToken) {
    // One token account is both treasury and payout: split it as the program did.
    const combined = developer;
    fee = computeFee(account.amount, account.feeBps);
    developer = combined - fee;
  }

  const left = -tokenDelta(transaction, escrow);
  if (fee < 0n || developer < 0n || client < 0n || fee + developer + client !== left) {
    throw new Error(`token movements of ${transaction.signature} do not add up to the escrow`);
  }
  return { fee, developer, client };
}

function fromUnix(seconds: bigint): Date | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1000);
}

/**
 * Records the terminal outcome of a task, once, from finalized data only: the
 * Task account read at `finalized` and the finalized transaction that produced
 * it. Safe to call any number of times and from concurrent requests.
 */
async function recordSettlement(deps: AppDeps, row: TaskRow): Promise<void> {
  const { pool, chain, taskra } = deps;
  const existing = await pool.query(`SELECT 1 FROM settlements WHERE task_id = $1`, [row.id]);
  if (existing.rowCount !== 0) return;

  const address = new PublicKey(row.task_address);
  const finalized = await chain.getTask(address, 'finalized');
  if (finalized === null || !isTerminalState(finalized.account.state)) return;
  const { account } = finalized;
  assertSameTask(row, account);

  const known = await pool.query<{ signature: string }>(
    `SELECT signature FROM onchain_transactions
      WHERE task_id = $1 AND instruction = ANY($2) AND status IN ('CONFIRMED', 'FINALIZED')
      ORDER BY first_seen_at DESC`,
    [row.id, OUTCOME_INSTRUCTIONS],
  );
  const candidates = [
    ...new Set([
      ...known.rows.map((entry) => entry.signature),
      ...(await chain.findFinalizedSignatures(address, SETTLEMENT_SEARCH_LIMIT)),
    ]),
  ];

  for (const signature of candidates) {
    const transaction = await chain.getTransaction(signature, 'finalized');
    if (transaction === null || transaction.error !== null) continue;
    let instruction: TaskraInstruction;
    try {
      instruction = findTaskraInstruction(transaction, taskra.programId.toBase58());
    } catch (error) {
      if (error instanceof TransactionMismatchError) continue;
      throw error;
    }
    if (
      !OUTCOME_INSTRUCTIONS.includes(instruction.name) ||
      instruction.accounts['task'] !== row.task_address
    ) {
      continue;
    }

    const escrow = findEscrowAddress(taskra.programId, address)[0].toBase58();
    const amounts = observedAmounts(transaction, instruction, account, escrow);
    const now = deps.now();
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot, block_time)
         VALUES ($1, $2, $3, 'FINALIZED', $4, $5)
         ON CONFLICT (signature) DO UPDATE SET status = 'FINALIZED', updated_at = $6
           WHERE onchain_transactions.task_id = EXCLUDED.task_id`,
        [
          signature,
          row.id,
          instruction.name,
          transaction.slot,
          transaction.blockTime === null ? null : new Date(transaction.blockTime * 1000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO settlements (task_id, signature, state, outcome, client_wallet,
                developer_wallet, amount, fee_amount, developer_amount, client_amount, disputed,
                accepted_at, closed_at, slot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (task_id) DO NOTHING`,
        [
          row.id,
          signature,
          account.state,
          account.outcome,
          account.client.toBase58(),
          account.developer?.toBase58() ?? null,
          account.amount.toString(),
          amounts.fee.toString(),
          amounts.developer.toString(),
          amounts.client.toString(),
          account.disputedAt !== 0n,
          fromUnix(account.acceptedAt),
          fromUnix(account.closedAt) ?? now,
          transaction.slot,
        ],
      );
      await writeCache(client, row, finalized, now);
    });
    return;
  }
  // The outcome is final on-chain but its transaction was not among the most
  // recent ones for this address. Nothing is recorded; the next read retries.
}

export interface Reconciled {
  readonly row: TaskRow;
  /** The Task account as read at `confirmed`, or `null` if there is none. */
  readonly snapshot: TaskSnapshot | null;
  /** False when the RPC endpoint could not be reached and `row` is the last known cache. */
  readonly chainAvailable: boolean;
  /**
   * Set when finality bookkeeping failed for a reason other than an RPC outage
   * (for example token movements that do not add up). Nothing was recorded;
   * the caller logs it. The task itself is still served.
   */
  readonly problem: unknown;
}

/** Re-reads a task from the chain and updates everything derived from it. */
export async function reconcileTask(deps: AppDeps, row: TaskRow): Promise<Reconciled> {
  let snapshot: TaskSnapshot | null;
  try {
    snapshot = await deps.chain.getTask(new PublicKey(row.task_address), 'confirmed');
  } catch (error) {
    if (error instanceof ChainUnavailableError) {
      return { row, snapshot: null, chainAvailable: false, problem: undefined };
    }
    throw error;
  }
  let current = await writeCache(deps.pool, row, snapshot, deps.now());
  let problem: unknown;
  try {
    await settlePendingTransactions(deps, row.id);
    if (snapshot !== null && isTerminalState(snapshot.account.state)) {
      await recordSettlement(deps, current);
      const reread = await deps.pool.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [row.id]);
      current = reread.rows[0] ?? current;
    }
  } catch (error) {
    // The display cache above is already fresh; finality bookkeeping retries on the next read.
    if (!(error instanceof ChainUnavailableError)) problem = error;
  }
  return { row: current, snapshot, chainAvailable: true, problem };
}

export interface Observation {
  readonly transaction: ObservedTransaction;
  readonly instruction: TaskraInstruction;
  readonly status: TransactionStatus;
  readonly errorName: string | null;
}

/**
 * Verifies a reported signature against the chain and stores the observation.
 *
 * The report contributes only the signature. Which program it called, which
 * instruction, for which task, and whether it succeeded are all read from the
 * transaction itself; anything that does not match this task is refused.
 */
export async function observeTransaction(
  deps: AppDeps,
  row: TaskRow,
  signature: string,
  reportedBy: string,
  expected?: InstructionName,
): Promise<Observation> {
  const { pool, chain, taskra } = deps;
  const prior = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM onchain_transactions WHERE signature = $1`,
    [signature],
  );
  if (prior.rows[0] !== undefined && prior.rows[0].task_id !== row.id) {
    throw conflict('TRANSACTION_MISMATCH', 'This transaction belongs to a different task.');
  }

  let finalized = true;
  let transaction = await chain.getTransaction(signature, 'finalized');
  if (transaction === null) {
    finalized = false;
    transaction = await chain.getTransaction(signature, 'confirmed');
  }
  if (transaction === null) {
    throw new ApiError(
      404,
      'TRANSACTION_NOT_FOUND',
      'The transaction is not confirmed yet, or was dropped. Retry shortly.',
    );
  }

  let instruction: TaskraInstruction;
  try {
    instruction = findTaskraInstruction(transaction, taskra.programId.toBase58());
  } catch (error) {
    if (error instanceof TransactionMismatchError) {
      throw new ApiError(422, 'TRANSACTION_MISMATCH', error.message);
    }
    throw error;
  }
  if (instruction.accounts['task'] !== row.task_address) {
    throw new ApiError(422, 'TRANSACTION_MISMATCH', 'The transaction is for a different task.');
  }
  if (expected !== undefined && instruction.name !== expected) {
    throw new ApiError(
      422,
      'TRANSACTION_MISMATCH',
      `Expected a ${expected} transaction but this one is ${instruction.name}.`,
    );
  }

  const failed = transaction.error !== null;
  const status: TransactionStatus = failed ? 'FAILED' : finalized ? 'FINALIZED' : 'CONFIRMED';
  const decoded = failed ? decodeProgramError({ err: transaction.error }) : null;
  const errorName = decoded === null ? null : decoded.kind === 'unknown' ? null : decoded.name;

  // A final status is never downgraded by a later, less final report.
  await pool.query(
    `INSERT INTO onchain_transactions
            (signature, task_id, instruction, status, slot, block_time, error_code, error_name,
             reported_by, first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (signature) DO UPDATE
       SET status = CASE WHEN onchain_transactions.status IN ('FINALIZED', 'FAILED')
                         THEN onchain_transactions.status ELSE EXCLUDED.status END,
           updated_at = EXCLUDED.updated_at
     WHERE onchain_transactions.task_id = EXCLUDED.task_id`,
    [
      signature,
      row.id,
      instruction.name,
      status,
      transaction.slot,
      transaction.blockTime === null ? null : new Date(transaction.blockTime * 1000),
      decoded?.code ?? null,
      errorName,
      reportedBy,
      deps.now(),
    ],
  );
  return { transaction, instruction, status, errorName };
}
