// The attestation service's work loop.
//
//   verification job -> verification_results row (always, append-only)
//                    -> attestations row (only with a VERIFIED result, once)
//                    -> one record_attestation on-chain for that submission
//
// The API can only queue a job. Everything a job leads to is re-derived here
// from the finalized Task account and from GitHub, so a forged or replayed
// queue entry cannot produce an attestation that the facts do not support.

import { PublicKey } from '@solana/web3.js';
import {
  decodeProgramError,
  fromHex,
  hasValidAttestation,
  type TaskAccount,
  termsMatchTask,
  toHex,
} from '@taskra/sdk';
import { isUniqueViolation, withTransaction } from '@taskra/shared/db';
import type pg from 'pg';
import type { AttesterChain } from './chain.js';
import type { GithubCallMeta, GithubClient, GithubOutcome, PullRequest } from './github.js';
import {
  checkPreconditions,
  evaluateEvidence,
  type RuleResult,
  RULESET_VERSION,
  type VerificationStatus,
} from './rules.js';
import type { AttestationSigner } from './signer.js';

export const VERIFIER_VERSION = 'taskra-attester/1';

/** A claimed job that is not finished within this time may be claimed again. */
const JOB_LEASE_MS = 2 * 60 * 1000;
/** PENDING results are retried this many times, with backoff, then left for a new request. */
export const MAX_VERIFICATION_ATTEMPTS = 40;
/** A sent transaction that the cluster still does not know after this long is re-sent. */
export const RESEND_AFTER_MS = 90 * 1000;
export const MAX_SEND_ATTEMPTS = 5;
const JOBS_PER_TICK = 10;

export interface WorkerLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WorkerDeps {
  /** Connections already dropped to the `taskra_attester` role. */
  readonly pool: pg.Pool;
  readonly chain: AttesterChain;
  readonly github: GithubClient;
  readonly signer: AttestationSigner;
  readonly now: () => Date;
  readonly log: WorkerLog;
}

interface SubmissionRow {
  id: string;
  task_id: string;
  submission_nonce: string;
  evidence_hash: string;
  pr_number: string;
  task_address: string;
  repo: string;
  acceptance_criteria: string;
  work_duration: string;
  amount: string;
}

interface AttestationRow {
  submission_id: string;
  task_address: string;
  evidence_hash: string;
  submission_nonce: string;
  status: 'REQUESTED' | 'SENT';
  signature: string | null;
  attempts: number;
  updated_at: Date;
}

/** Seconds to wait before retrying a PENDING verification: 5 s doubling to 5 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempts - 1), 300);
}

function attestedFor(account: TaskAccount, nonce: bigint, hash: string): boolean {
  return (
    hasValidAttestation(account) &&
    account.attestedNonce === nonce &&
    toHex(account.attestedHash) === hash
  );
}

function isoOrNull(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(value);
}

export interface Worker {
  /** Claims and processes one due job. Resolves `false` when none is due. */
  processNextJob(): Promise<boolean>;
  /** Advances every attestation that is not yet final. */
  driveAttestations(): Promise<void>;
  /** One full pass: due jobs, then open attestations. */
  tick(): Promise<void>;
}

export function createWorker(deps: WorkerDeps): Worker {
  const { pool, chain, github, signer, log } = deps;

  async function recordResult(
    submission: SubmissionRow,
    status: VerificationStatus,
    rules: readonly RuleResult[],
    details: {
      account: TaskAccount | null;
      slot: number | null;
      pullRequest: GithubOutcome<PullRequest> | null;
      recomputedHash: string | null;
      calls: readonly GithubCallMeta[];
    },
  ): Promise<void> {
    const pr = details.pullRequest?.kind === 'ok' ? details.pullRequest.value : null;
    const { account } = details;
    await withTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
                verifier_version, attester_pubkey, repo, pr_number, head_sha, merge_commit_sha,
                pr_author_id, pr_author_login, merged_by_id, merged_by_login, merged_at,
                repo_created_at, recomputed_evidence_hash, onchain_evidence_hash,
                onchain_submission_nonce, onchain_slot, github_meta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $20, $21, $22)
         RETURNING id`,
        [
          submission.id,
          status,
          JSON.stringify(rules),
          RULESET_VERSION,
          VERIFIER_VERSION,
          signer.publicKey.toBase58(),
          submission.repo,
          submission.pr_number,
          pr?.headSha ?? null,
          pr?.mergeCommitSha ?? null,
          pr?.author?.id ?? null,
          pr?.author?.login ?? null,
          pr?.mergedBy?.id ?? null,
          pr?.mergedBy?.login ?? null,
          isoOrNull(pr?.mergedAt),
          isoOrNull(pr?.baseRepoCreatedAt),
          details.recomputedHash,
          account === null || account.submissionNonce === 0n ? null : toHex(account.evidenceHash),
          account === null ? null : account.submissionNonce.toString(),
          details.slot,
          JSON.stringify({ calls: details.calls }),
          deps.now(),
        ],
      );
      if (status === 'VERIFIED') {
        // Same transaction as the result it depends on. The primary key makes a
        // second attestation for this submission impossible.
        await client.query(
          `INSERT INTO attestations (submission_id, verification_result_id, task_id,
                  evidence_hash, submission_nonce, attester_pubkey, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            submission.id,
            inserted.rows[0]?.id,
            submission.task_id,
            submission.evidence_hash,
            submission.submission_nonce,
            signer.publicKey.toBase58(),
            deps.now(),
          ],
        );
      }
    });
  }

  /** Verifies one submission. Resolves whether the job is finished or must be retried. */
  async function verify(submissionId: string): Promise<'done' | 'retry'> {
    const loaded = await pool.query<SubmissionRow>(
      `SELECT s.id, s.task_id, s.submission_nonce, s.evidence_hash, s.pr_number,
              t.task_address, t.repo, t.acceptance_criteria, t.work_duration, t.amount
         FROM submissions s JOIN tasks t ON t.id = s.task_id
        WHERE s.id = $1`,
      [submissionId],
    );
    const submission = loaded.rows[0];
    if (submission === undefined) return 'done';

    // Once an attestation exists for this submission there is nothing left to verify.
    const existing = await pool.query(`SELECT 1 FROM attestations WHERE submission_id = $1`, [
      submissionId,
    ]);
    if (existing.rowCount !== 0) return 'done';

    const record = {
      submissionNonce: BigInt(submission.submission_nonce),
      evidenceHash: submission.evidence_hash,
      prNumber: BigInt(submission.pr_number),
    };

    // Finalized, not confirmed: a submission that could still be forked away is
    // never verified.
    const read = await chain.getTask(new PublicKey(submission.task_address), 'finalized');
    if (read === null) {
      await recordResult(
        submission,
        'PENDING',
        [{ rule: 'P2', passed: null, reason: 'The task is not finalized on-chain yet.' }],
        { account: null, slot: null, pullRequest: null, recomputedHash: null, calls: [] },
      );
      return 'retry';
    }
    const { account, slot } = read;
    if (attestedFor(account, record.submissionNonce, record.evidenceHash)) return 'done';

    const preconditions = checkPreconditions({
      task: account,
      chainTime: await chain.getChainTime('finalized'),
      termsMatch: termsMatchTask(
        {
          repo: submission.repo,
          acceptanceCriteria: submission.acceptance_criteria,
          workDuration: BigInt(submission.work_duration),
          amount: BigInt(submission.amount),
        },
        account,
      ),
      submission: record,
    });
    if (preconditions.kind !== 'proceed') {
      const status = preconditions.kind === 'rejected' ? 'REJECTED' : 'PENDING';
      await recordResult(submission, status, preconditions.rules, {
        account,
        slot,
        pullRequest: null,
        recomputedHash: null,
        calls: [],
      });
      return preconditions.kind === 'rejected' ? 'done' : 'retry';
    }

    const developer = account.developer?.toBase58() ?? null;
    const link = await pool.query<{ github_user_id: string }>(
      `SELECT github_user_id FROM github_accounts WHERE wallet = $1`,
      [developer],
    );
    const linked = link.rows[0];

    const pullRequest = await github.getPullRequest(submission.repo, record.prNumber);
    const repository =
      pullRequest.kind === 'not_found' ? await github.getRepository(submission.repo) : null;
    const verdict = evaluateEvidence(
      {
        repo: submission.repo,
        task: account,
        submission: record,
        developerGithubId: linked === undefined ? null : BigInt(linked.github_user_id),
        pullRequest,
        repository,
      },
      preconditions.rules,
    );

    try {
      await recordResult(submission, verdict.status, verdict.rules, {
        account,
        slot,
        pullRequest,
        recomputedHash: verdict.recomputedHash,
        calls: [pullRequest.meta, ...(repository === null ? [] : [repository.meta])],
      });
    } catch (error) {
      // Another worker recorded the VERIFIED result first. One is enough.
      if (isUniqueViolation(error)) return 'done';
      throw error;
    }
    log.info(
      { submissionId, taskId: submission.task_id, status: verdict.status },
      'verification result recorded',
    );
    return verdict.status === 'PENDING' ? 'retry' : 'done';
  }

  async function processNextJob(): Promise<boolean> {
    const now = deps.now();
    const claimed = await pool.query<{ submission_id: string; attempts: number }>(
      `UPDATE verification_jobs
          SET status = 'RUNNING', attempts = attempts + 1, locked_until = $2, updated_at = $1
        WHERE submission_id = (
                SELECT submission_id FROM verification_jobs
                 WHERE (status = 'QUEUED' AND run_after <= $1)
                    OR (status = 'RUNNING' AND locked_until < $1)
                 ORDER BY run_after
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED)
      RETURNING submission_id, attempts`,
      [now, new Date(now.getTime() + JOB_LEASE_MS)],
    );
    const job = claimed.rows[0];
    if (job === undefined) return false;

    let outcome: 'done' | 'retry';
    try {
      outcome = await verify(job.submission_id);
    } catch (error) {
      // RPC or database trouble: not a verdict. Leave no result and try again.
      log.warn({ submissionId: job.submission_id, err: error }, 'verification attempt failed');
      outcome = 'retry';
    }
    const finished = outcome === 'done' || job.attempts >= MAX_VERIFICATION_ATTEMPTS;
    const after = deps.now();
    await pool.query(
      `UPDATE verification_jobs
          SET status = $2, run_after = $3, locked_until = NULL, updated_at = $4
        WHERE submission_id = $1 AND status = 'RUNNING'`,
      [
        job.submission_id,
        finished ? 'DONE' : 'QUEUED',
        new Date(after.getTime() + backoffSeconds(job.attempts) * 1000),
        after,
      ],
    );
    return true;
  }

  async function finish(
    row: AttestationRow,
    status: 'FINALIZED' | 'FAILED',
    error: string | null,
  ): Promise<void> {
    await pool.query(
      `UPDATE attestations SET status = $2, last_error = $3, updated_at = $4
        WHERE submission_id = $1 AND status IN ('REQUESTED', 'SENT')`,
      [row.submission_id, status, error, deps.now()],
    );
    const level = status === 'FAILED' ? 'warn' : 'info';
    log[level](
      { submissionId: row.submission_id, signature: row.signature, error },
      `attestation ${status}`,
    );
  }

  async function driveOne(row: AttestationRow): Promise<void> {
    const address = new PublicKey(row.task_address);
    const nonce = BigInt(row.submission_nonce);

    const finalized = await chain.getTask(address, 'finalized');
    if (finalized !== null && attestedFor(finalized.account, nonce, row.evidence_hash)) {
      await finish(row, 'FINALIZED', null);
      return;
    }
    const confirmed = await chain.getTask(address, 'confirmed');
    const account = confirmed?.account ?? null;
    // Recorded, waiting for finality.
    if (account !== null && attestedFor(account, nonce, row.evidence_hash)) return;

    if (
      account === null ||
      account.state !== 'SUBMITTED' ||
      account.submissionNonce !== nonce ||
      toHex(account.evidenceHash) !== row.evidence_hash
    ) {
      await finish(row, 'FAILED', 'The submission is no longer the current one on-chain.');
      return;
    }
    if ((await chain.getChainTime('confirmed')) > account.verificationDeadline) {
      await finish(
        row,
        'FAILED',
        'The verification deadline passed before the attestation was recorded.',
      );
      return;
    }

    if (row.status === 'SENT' && row.signature !== null) {
      const state = await chain.getSignatureState(row.signature);
      if (state !== null) {
        if (state.error === null) return; // landed; the account read will catch up
        const decoded = decodeProgramError({ err: state.error });
        const name = decoded === null || decoded.kind === 'unknown' ? 'an error' : decoded.name;
        await finish(row, 'FAILED', `record_attestation failed on-chain with ${name}.`);
        return;
      }
      // Unknown to the cluster. It may still land until its blockhash expires.
      if (deps.now().getTime() - row.updated_at.getTime() < RESEND_AFTER_MS) return;
    }
    if (row.attempts >= MAX_SEND_ATTEMPTS) {
      await finish(row, 'FAILED', `Not recorded after ${String(MAX_SEND_ATTEMPTS)} attempts.`);
      return;
    }

    const signed = signer.signAttestation({
      task: address,
      evidenceHash: fromHex(row.evidence_hash),
      submissionNonce: nonce,
      recentBlockhash: await chain.getLatestBlockhash(),
    });
    // Persist the signature before broadcasting, and only if nobody else moved
    // this row meanwhile: a crash after the send can then never lose track of it.
    const claimed = await pool.query(
      `UPDATE attestations
          SET status = 'SENT', signature = $2, attempts = attempts + 1, last_error = NULL,
              updated_at = $3
        WHERE submission_id = $1 AND status = $4 AND attempts = $5`,
      [row.submission_id, signed.signature, deps.now(), row.status, row.attempts],
    );
    if (claimed.rowCount === 0) return;
    try {
      await chain.sendTransaction(signed.serialized);
      log.info(
        { submissionId: row.submission_id, signature: signed.signature },
        'record_attestation sent',
      );
    } catch (error) {
      // Stays SENT. The next pass re-checks the chain and re-sends when due.
      const decoded = decodeProgramError(error);
      const reason =
        decoded === null || decoded.kind === 'unknown'
          ? 'The RPC endpoint did not accept the transaction.'
          : `Preflight failed with ${decoded.name}.`;
      await pool.query(`UPDATE attestations SET last_error = $2 WHERE submission_id = $1`, [
        row.submission_id,
        reason,
      ]);
      log.warn({ submissionId: row.submission_id, reason }, 'record_attestation was not sent');
    }
  }

  async function driveAttestations(): Promise<void> {
    const open = await pool.query<AttestationRow>(
      `SELECT a.submission_id, t.task_address, a.evidence_hash, a.submission_nonce, a.status,
              a.signature, a.attempts, a.updated_at
         FROM attestations a JOIN tasks t ON t.id = a.task_id
        WHERE a.status IN ('REQUESTED', 'SENT')
        ORDER BY a.created_at
        LIMIT 50`,
    );
    for (const row of open.rows) {
      try {
        await driveOne(row);
      } catch (error) {
        log.warn({ submissionId: row.submission_id, err: error }, 'attestation pass failed');
      }
    }
  }

  return {
    processNextJob,
    driveAttestations,
    async tick() {
      for (let count = 0; count < JOBS_PER_TICK; count += 1) {
        if (!(await processNextJob())) break;
      }
      await driveAttestations();
    },
  };
}
