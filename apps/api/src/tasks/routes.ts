import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  bytesEqual,
  canonicalRepo,
  findTaskAddress,
  type InstructionName,
  MAX_WORK_DURATION,
  normalizeAcceptanceCriteria,
  rejectionReasonHash,
  TASK_STATES,
  taskIdFromUuid,
  termsHash,
  toHex,
  U64_MAX,
} from '@taskra/sdk';
import { PublicKey } from '@solana/web3.js';
import { isRestrictViolation } from '@taskra/shared/db';
import { z } from 'zod';
import { findSession, requireSession } from '../auth/routes.js';
import { hashArgument } from '../chain/parse.js';
import type { AppDeps } from '../deps.js';
import { ApiError, conflict, forbidden, notFound } from '../errors.js';
import { decimalStringSchema, signatureSchema, uuidSchema, walletSchema } from '../validation.js';
import { observeTransaction, reconcileTask, type TaskRow } from './reconcile.js';
import { taskDetail, taskSummary, verificationView } from './view.js';

const idParams = z.object({ id: uuidSchema });

const createBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  repo: z.string().max(200),
  acceptanceCriteria: z.string().max(10_000),
  /** Seconds the developer has after accepting. */
  workDuration: decimalStringSchema,
  /** Token base units. */
  amount: decimalStringSchema,
});

const listQuery = z.object({
  state: z.enum(['DRAFT', ...TASK_STATES]).optional(),
  client: walletSchema.optional(),
  developer: walletSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const reportBody = z.strictObject({ signature: signatureSchema });
const rejectBody = z.strictObject({
  signature: signatureSchema,
  reason: z.string().min(1).max(5_000),
});
const evidenceBody = z.strictObject({
  prNumber: z.number().int().min(1).max(2_147_483_647),
  signature: signatureSchema.optional(),
});

const WRITE_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const EVIDENCE_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Routes that report one specific instruction (docs/05-API-SPEC.md). */
const REPORT_ROUTES: readonly (readonly [string, InstructionName])[] = [
  ['fund', 'create_and_fund_task'],
  ['accept', 'accept_task'],
  ['approve', 'approve_task'],
];

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool, taskra } = deps;

  async function loadTask(request: FastifyRequest): Promise<TaskRow> {
    const { id } = idParams.parse(request.params);
    const result = await pool.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw notFound('Task');
    return row;
  }

  async function detail(row: TaskRow) {
    const reconciled = await reconcileTask(deps, row);
    if (reconciled.problem !== undefined) {
      app.log.error({ err: reconciled.problem, taskId: row.id }, 'settlement was not recorded');
    }
    return {
      reconciled,
      view: await taskDetail(pool, reconciled.row, reconciled.snapshot, reconciled.chainAvailable),
    };
  }

  // T0: a draft is metadata only. Nothing exists on-chain and no funds move.
  app.post('/api/v1/tasks', { config: WRITE_RATE_LIMIT }, async (request, reply) => {
    const session = await requireSession(deps, request);
    const body = createBody.parse(request.body);

    const amount = BigInt(body.amount);
    const workDuration = BigInt(body.workDuration);
    if (amount === 0n || amount > U64_MAX) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'amount must be between 1 and 2^64 - 1.');
    }
    // The program is the authority on this bound (MAX_WORK_DURATION comes from
    // its IDL); refusing here only saves the client a transaction that would fail.
    if (workDuration === 0n || workDuration > MAX_WORK_DURATION) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `workDuration must be between 1 and ${MAX_WORK_DURATION.toString()} seconds (365 days).`,
      );
    }
    const repo = canonicalRepo(body.repo);
    const acceptanceCriteria = normalizeAcceptanceCriteria(body.acceptanceCriteria);
    if (acceptanceCriteria === '') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'acceptanceCriteria must not be empty.');
    }

    // The id, the terms hash and the Task address are all derived here; a
    // client cannot choose any of them.
    const id = randomUUID();
    const hash = termsHash({ repo, acceptanceCriteria, workDuration, amount });
    const address = findTaskAddress(
      taskra.programId,
      new PublicKey(session.wallet),
      taskIdFromUuid(id),
    )[0];
    const inserted = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, client_wallet, task_address, title, description, repo,
              acceptance_criteria, work_duration, amount, terms_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        session.wallet,
        address.toBase58(),
        body.title,
        body.description,
        repo,
        acceptanceCriteria,
        workDuration.toString(),
        amount.toString(),
        toHex(hash),
        deps.now(),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return reply.status(201).send({ task: taskSummary(row) });
  });

  // Served from the cache: each entry says when and how finally it was observed.
  app.get('/api/v1/tasks', async (request) => {
    const query = listQuery.parse(request.query);
    const session = await findSession(deps, request);
    const result = await pool.query<TaskRow>(
      `SELECT * FROM tasks
        WHERE (chain_state IS NOT NULL OR client_wallet = $1)
          AND ($2::text IS NULL
               OR chain_state = $2
               OR ($2 = 'DRAFT' AND chain_state IS NULL))
          AND ($3::text IS NULL OR client_wallet = $3)
          AND ($4::text IS NULL OR chain_developer = $4)
        ORDER BY created_at DESC, id
        LIMIT $5 OFFSET $6`,
      [
        session?.wallet ?? null,
        query.state ?? null,
        query.client ?? null,
        query.developer ?? null,
        query.limit,
        query.offset,
      ],
    );
    return { tasks: result.rows.map(taskSummary), limit: query.limit, offset: query.offset };
  });

  app.get('/api/v1/tasks/:id', async (request) => {
    const row = await loadTask(request);
    const { reconciled, view } = await detail(row);
    if (reconciled.row.chain_state === null) {
      // A draft is private to the wallet that wrote it.
      const session = await findSession(deps, request);
      if (session?.wallet !== row.client_wallet) throw notFound('Task');
    }
    return { task: view };
  });

  app.get('/api/v1/tasks/:id/verification', async (request) => {
    const row = await loadTask(request);
    if (row.chain_state === null) throw notFound('Task');
    return { verification: await verificationView(pool, row.id) };
  });

  async function report(request: FastifyRequest, expected?: InstructionName) {
    const session = await requireSession(deps, request);
    const { signature } = reportBody.parse(request.body);
    const row = await loadTask(request);
    const observation = await observeTransaction(deps, row, signature, session.wallet, expected);
    const { view } = await detail(row);
    return {
      transaction: {
        signature,
        instruction: observation.instruction.name,
        status: observation.status,
        error: observation.errorName,
      },
      task: view,
    };
  }

  for (const [path, instruction] of REPORT_ROUTES) {
    app.post(`/api/v1/tasks/:id/${path}`, { config: WRITE_RATE_LIMIT }, (request) =>
      report(request, instruction),
    );
  }

  // Every other instruction (cancel, refund, disputes, expiries, attestation).
  app.post('/api/v1/tasks/:id/transactions', { config: WRITE_RATE_LIMIT }, (request) =>
    report(request),
  );

  app.post('/api/v1/tasks/:id/reject', { config: WRITE_RATE_LIMIT }, async (request) => {
    const session = await requireSession(deps, request);
    const body = rejectBody.parse(request.body);
    const row = await loadTask(request);
    if (session.wallet !== row.client_wallet) {
      throw forbidden('Only the client of this task can record a rejection reason.');
    }
    const observation = await observeTransaction(
      deps,
      row,
      body.signature,
      session.wallet,
      'reject_task',
    );
    if (observation.status !== 'FAILED') {
      const hash = rejectionReasonHash(body.reason);
      if (!bytesEqual(hash, hashArgument(observation.instruction))) {
        throw new ApiError(
          422,
          'REASON_MISMATCH',
          'The reason does not match the hash recorded by the transaction.',
        );
      }
      await pool.query(
        `INSERT INTO rejection_reasons (task_id, reason_hash, reason, author_wallet, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (task_id) DO NOTHING`,
        [row.id, toHex(hash), body.reason.normalize('NFC').trim(), session.wallet, deps.now()],
      );
    }
    const { view } = await detail(row);
    return {
      transaction: {
        signature: body.signature,
        instruction: observation.instruction.name,
        status: observation.status,
        error: observation.errorName,
      },
      task: view,
    };
  });

  // Registers which pull request the current on-chain submission refers to and
  // queues it for verification. The hash and nonce are read from the Task
  // account; the pull-request number is a claim the verifier checks (R9).
  app.post('/api/v1/tasks/:id/evidence', { config: EVIDENCE_RATE_LIMIT }, async (request) => {
    const session = await requireSession(deps, request);
    const body = evidenceBody.parse(request.body);
    const row = await loadTask(request);

    const observation =
      body.signature === undefined
        ? null
        : await observeTransaction(deps, row, body.signature, session.wallet, 'submit_work');
    if (observation?.status === 'FAILED') {
      throw new ApiError(422, 'TRANSACTION_FAILED', 'The submit_work transaction failed.');
    }

    const { reconciled } = await detail(row);
    if (!reconciled.chainAvailable) {
      throw new ApiError(503, 'RPC_UNAVAILABLE', 'The Solana RPC endpoint is unavailable.');
    }
    const account = reconciled.snapshot?.account;
    if (account === undefined || account.submissionNonce === 0n) {
      throw conflict('NO_SUBMISSION', 'No submission is recorded on-chain for this task.');
    }
    if (account.developer?.toBase58() !== session.wallet) {
      throw forbidden('Only the developer of this task can register evidence.');
    }
    if (
      observation !== null &&
      !bytesEqual(hashArgument(observation.instruction), account.evidenceHash)
    ) {
      throw conflict(
        'STALE_SUBMISSION',
        'The task has been resubmitted since this transaction. Register the latest submission.',
      );
    }

    const now = deps.now();
    await pool.query(
      `INSERT INTO submissions (task_id, submission_nonce, evidence_hash, pr_number,
              submitter_wallet, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id, submission_nonce) DO NOTHING`,
      [
        row.id,
        account.submissionNonce.toString(),
        toHex(account.evidenceHash),
        body.prNumber,
        session.wallet,
        now,
      ],
    );
    const stored = await pool.query<{ id: string; pr_number: string; evidence_hash: string }>(
      `SELECT id, pr_number, evidence_hash FROM submissions
        WHERE task_id = $1 AND submission_nonce = $2`,
      [row.id, account.submissionNonce.toString()],
    );
    const submission = stored.rows[0];
    if (submission === undefined) throw new Error('submission row is missing');
    if (submission.evidence_hash !== toHex(account.evidenceHash)) {
      throw conflict('STALE_SUBMISSION', 'The on-chain submission changed. Try again.');
    }
    let corrected = false;
    if (submission.pr_number !== String(body.prNumber)) {
      // Correcting which pull request a submission refers to is safe while
      // nothing is verified: the on-chain hash commits to the repository, the
      // number and the head commit, so a number that is not the hashed one can
      // never verify, and the hashed one is the only number that ever can.
      // Once a VERIFIED result or an attestation exists the registration is
      // final. The database decides that, under a lock on the submission row
      // that the attestation service's VERIFIED record also takes, so the two
      // cannot interleave (migrations 1760100000000 and 1760300000000).
      try {
        await pool.query(`UPDATE submissions SET pr_number = $2 WHERE id = $1`, [
          submission.id,
          body.prNumber,
        ]);
      } catch (error) {
        if (!isRestrictViolation(error)) throw error;
        throw conflict(
          'EVIDENCE_LOCKED',
          'This submission has been verified; its pull request can no longer be changed.',
        );
      }
      corrected = true;
    }
    // A finished job that produced no attestation may be run again, for
    // example once the pull request has been merged.
    await pool.query(
      `INSERT INTO verification_jobs (submission_id, requested_at, run_after, updated_at)
       VALUES ($1, $2, $2, $2)
       ON CONFLICT (submission_id) DO UPDATE
         SET status = 'QUEUED', attempts = 0, run_after = $2, locked_until = NULL, updated_at = $2
       WHERE verification_jobs.status = 'DONE'
         AND NOT EXISTS (SELECT 1 FROM attestations a
                          WHERE a.submission_id = verification_jobs.submission_id)`,
      [submission.id, now],
    );
    if (corrected) {
      // Verify the corrected registration from scratch, even if a run for the
      // old number is in flight: that run's result names the number it used.
      await pool.query(
        `UPDATE verification_jobs
            SET status = 'QUEUED', attempts = 0, run_after = $2, locked_until = NULL, updated_at = $2
          WHERE submission_id = $1`,
        [submission.id, now],
      );
    }

    const { view } = await detail(row);
    return { task: view };
  });
}
