// JSON shapes of a task. Amounts and u64/i64 values are decimal strings.

import { hasValidAttestation, splitSettlement, toHex } from '@taskra/sdk';
import type { Queryable } from '@taskra/shared/db';
import type { TaskSnapshot } from '../chain/reader.js';
import { type TaskRow, termsMatch } from './reconcile.js';

function unix(seconds: bigint): string | null {
  return seconds === 0n ? null : seconds.toString();
}

/** What the list and every other response say about a task: metadata plus the cached state. */
export function taskSummary(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    repo: row.repo,
    acceptanceCriteria: row.acceptance_criteria,
    workDuration: row.work_duration,
    amount: row.amount,
    termsHash: row.terms_hash,
    taskAddress: row.task_address,
    clientWallet: row.client_wallet,
    createdAt: row.created_at.toISOString(),
    /** `DRAFT` until a Task account has been observed on-chain. */
    state: row.chain_state ?? 'DRAFT',
    developerWallet: row.chain_developer,
    /** False when the on-chain terms hash does not match this metadata: treat it as unverified. */
    termsVerified: row.chain_terms_match,
    observed:
      row.chain_state === null
        ? null
        : {
            commitment: row.chain_commitment,
            slot: row.chain_slot,
            at: row.chain_synced_at?.toISOString() ?? null,
          },
  };
}

/** The Task account exactly as read, for callers that want the authoritative fields. */
function chainView(row: TaskRow, snapshot: TaskSnapshot) {
  const { account } = snapshot;
  const split = splitSettlement(account.amount, account.feeBps);
  return {
    commitment: snapshot.commitment,
    slot: snapshot.slot.toString(),
    state: account.state,
    outcome: account.outcome,
    client: account.client.toBase58(),
    developer: account.developer?.toBase58() ?? null,
    amount: account.amount.toString(),
    feeBps: account.feeBps,
    fee: split.fee.toString(),
    developerAmount: split.developerAmount.toString(),
    termsHash: toHex(account.termsHash),
    termsVerified: termsMatch(row, account),
    submissionNonce: account.submissionNonce.toString(),
    evidenceHash: account.submissionNonce === 0n ? null : toHex(account.evidenceHash),
    hasValidAttestation: hasValidAttestation(account),
    rejectionReasonHash:
      account.disputedAt !== 0n && account.rejectionReasonHash.some((byte) => byte !== 0)
        ? toHex(account.rejectionReasonHash)
        : null,
    times: {
      createdAt: unix(account.createdAt),
      acceptedAt: unix(account.acceptedAt),
      workDeadline: unix(account.workDeadline),
      verificationDeadline: unix(account.verificationDeadline),
      submittedAt: unix(account.submittedAt),
      disputeOpenAt: unix(account.disputeOpenAt),
      refundOpenAt: unix(account.refundOpenAt),
      verifiedAt: unix(account.verifiedAt),
      reviewDeadline: unix(account.reviewDeadline),
      disputedAt: unix(account.disputedAt),
      disputeDeadline: unix(account.disputeDeadline),
      closedAt: unix(account.closedAt),
    },
  };
}

interface TransactionRow {
  signature: string;
  instruction: string;
  status: string;
  slot: string;
  block_time: Date | null;
  error_name: string | null;
}

interface SettlementRow {
  signature: string;
  state: string;
  outcome: string;
  amount: string;
  fee_amount: string;
  developer_amount: string;
  client_amount: string;
  disputed: boolean;
  closed_at: Date;
  slot: string;
}

export async function verificationView(db: Queryable, taskId: string) {
  const result = await db.query<{
    submission_nonce: string;
    evidence_hash: string;
    pr_number: string;
    created_at: Date;
    job_status: string | null;
    job_attempts: number | null;
    result_status: string | null;
    rules: unknown;
    head_sha: string | null;
    merge_commit_sha: string | null;
    pr_author_login: string | null;
    merged_by_login: string | null;
    merged_at: Date | null;
    checked_at: Date | null;
    attestation_status: string | null;
    attestation_signature: string | null;
    attestation_error: string | null;
  }>(
    `SELECT s.submission_nonce, s.evidence_hash, s.pr_number, s.created_at,
            j.status AS job_status, j.attempts AS job_attempts,
            r.status AS result_status, r.rules, r.head_sha, r.merge_commit_sha,
            r.pr_author_login, r.merged_by_login, r.merged_at, r.created_at AS checked_at,
            a.status AS attestation_status, a.signature AS attestation_signature,
            a.last_error AS attestation_error
       FROM submissions s
       LEFT JOIN verification_jobs j ON j.submission_id = s.id
       -- Only a result for the number that is registered now: after a
       -- correction, a run for the old number says nothing about the new one.
       LEFT JOIN LATERAL (SELECT * FROM verification_results v
                           WHERE v.submission_id = s.id AND v.pr_number = s.pr_number
                           ORDER BY v.id DESC LIMIT 1) r ON true
       LEFT JOIN attestations a ON a.submission_id = s.id
      WHERE s.task_id = $1
      ORDER BY s.submission_nonce DESC`,
    [taskId],
  );
  return result.rows.map((row) => ({
    submissionNonce: row.submission_nonce,
    evidenceHash: row.evidence_hash,
    prNumber: row.pr_number,
    registeredAt: row.created_at.toISOString(),
    /** PENDING until a run has produced a final answer. */
    status: row.result_status ?? 'PENDING',
    job: row.job_status === null ? null : { status: row.job_status, attempts: row.job_attempts },
    result:
      row.result_status === null
        ? null
        : {
            checkedAt: row.checked_at?.toISOString() ?? null,
            rules: row.rules,
            headSha: row.head_sha,
            mergeCommitSha: row.merge_commit_sha,
            prAuthor: row.pr_author_login,
            mergedBy: row.merged_by_login,
            mergedAt: row.merged_at?.toISOString() ?? null,
          },
    attestation:
      row.attestation_status === null
        ? null
        : {
            status: row.attestation_status,
            signature: row.attestation_signature,
            error: row.attestation_error,
          },
  }));
}

/** Everything about one task. `snapshot` is the live chain read, when one was possible. */
export async function taskDetail(
  db: Queryable,
  row: TaskRow,
  snapshot: TaskSnapshot | null,
  chainAvailable: boolean,
) {
  const transactions = await db.query<TransactionRow>(
    `SELECT signature, instruction, status, slot, block_time, error_name
       FROM onchain_transactions WHERE task_id = $1 ORDER BY first_seen_at, signature`,
    [row.id],
  );
  const settlement = await db.query<SettlementRow>(
    `SELECT signature, state, outcome, amount, fee_amount, developer_amount, client_amount,
            disputed, closed_at, slot
       FROM settlements WHERE task_id = $1`,
    [row.id],
  );
  const rejection = await db.query<{ reason: string; reason_hash: string }>(
    `SELECT reason, reason_hash FROM rejection_reasons WHERE task_id = $1`,
    [row.id],
  );
  const settled = settlement.rows[0];
  // Reason text is shown only while it still matches the hash on the Task account.
  const reason = rejection.rows[0];
  const reasonHash = snapshot === null ? null : toHex(snapshot.account.rejectionReasonHash);

  return {
    ...taskSummary(row),
    /** `live`: read from Solana for this response. `cache`: the RPC endpoint was unreachable. */
    chainSource: chainAvailable ? 'live' : 'cache',
    chain: snapshot === null ? null : chainView(row, snapshot),
    transactions: transactions.rows.map((entry) => ({
      signature: entry.signature,
      instruction: entry.instruction,
      status: entry.status,
      slot: entry.slot,
      blockTime: entry.block_time?.toISOString() ?? null,
      error: entry.error_name,
    })),
    /** Present only once the outcome transaction is finalized. */
    settlement:
      settled === undefined
        ? null
        : {
            signature: settled.signature,
            commitment: 'finalized',
            state: settled.state,
            outcome: settled.outcome,
            amount: settled.amount,
            feeAmount: settled.fee_amount,
            developerAmount: settled.developer_amount,
            clientAmount: settled.client_amount,
            disputed: settled.disputed,
            closedAt: settled.closed_at.toISOString(),
            slot: settled.slot,
          },
    rejection:
      reason === undefined || (reasonHash !== null && reasonHash !== reason.reason_hash)
        ? null
        : { reason: reason.reason, reasonHash: reason.reason_hash },
    verification: await verificationView(db, row.id),
  };
}
