// The attestation service end to end against a real database: a queued job
// becomes an audit record and, only when VERIFIED, exactly one attestation.

import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createTaskraConfig, type TaskAccount, toHex } from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { type TestDatabase, testDatabase } from '@taskra/shared/testing/postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttestationSigner } from './signer.js';
import { FakeAttesterChain, FakeGithub, notFound, ok, unavailable } from './testing/fakes.js';
import {
  AMOUNT,
  CLIENT,
  CRITERIA,
  DEVELOPER,
  DEVELOPER_GITHUB_ID,
  HEAD_SHA,
  key,
  MERGE_SHA,
  mergedPullRequest,
  PR_NUMBER,
  REPO,
  submittedTask,
  VERIFICATION_DEADLINE,
  WORK_DURATION,
} from './testing/fixtures.js';
import {
  backoffSeconds,
  createWorker,
  MAX_SEND_ATTEMPTS,
  MAX_VERIFICATION_ATTEMPTS,
  RESEND_AFTER_MS,
  type Worker,
  type WorkerLog,
} from './worker.js';

const taskra = createTaskraConfig({ cluster: 'localnet', usdcMint: key(7) });
const keypair = Keypair.generate();
const signer = createAttestationSigner(JSON.stringify([...keypair.secretKey]), taskra);
const silent: WorkerLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

let database: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let chain: FakeAttesterChain;
let github: FakeGithub;
let worker: Worker;
let clock: number;

beforeAll(async () => {
  database = await testDatabase();
  owner = new pg.Pool({ connectionString: database.url, max: 2 });
  pool = createPool(database.url, 'taskra_attester');
  await owner.query(`INSERT INTO wallets (address) VALUES ($1), ($2)`, [
    CLIENT.toBase58(),
    DEVELOPER.toBase58(),
  ]);
  await owner.query(
    `INSERT INTO github_accounts (wallet, github_user_id, login) VALUES ($1, $2, 'dev-octocat')`,
    [DEVELOPER.toBase58(), DEVELOPER_GITHUB_ID],
  );
});
afterAll(async () => {
  await Promise.all([owner.end(), pool.end()]);
  await database.drop();
});

beforeEach(async () => {
  // Jobs left over from earlier tests must not be picked up by this one.
  await owner.query(`UPDATE verification_jobs SET status = 'DONE'`);
  await owner.query(
    `UPDATE attestations SET status = 'FAILED' WHERE status IN ('REQUESTED', 'SENT')`,
  );
  clock = new Date('2026-10-09T12:00:00Z').getTime();
  chain = new FakeAttesterChain(taskra.programId, keypair.publicKey);
  github = new FakeGithub();
  github.pullRequest = ok(mergedPullRequest());
  worker = newWorker();
});

function newWorker(): Worker {
  return createWorker({
    pool,
    chain,
    github,
    signer,
    now: () => new Date(clock),
    log: silent,
  });
}

interface Seeded {
  readonly taskId: string;
  readonly address: PublicKey;
  readonly submissionId: string;
}

/** A task with one registered, queued submission; the chain has it SUBMITTED and finalized. */
async function seed(
  options: { account?: Partial<TaskAccount>; repo?: string; nonce?: bigint } = {},
): Promise<Seeded> {
  const taskId = randomUUID();
  // A distinct, well-formed address per task.
  const taskAddress = new PublicKey(randomBytes(32));
  const unique = taskAddress.toBase58();
  const account = submittedTask(options.account);
  await owner.query(
    `INSERT INTO tasks (id, client_wallet, task_address, title, description, repo,
            acceptance_criteria, work_duration, amount, terms_hash)
     VALUES ($1, $2, $3, 'Parser', '', $4, $5, $6, $7, $8)`,
    [
      taskId,
      CLIENT.toBase58(),
      unique,
      options.repo ?? REPO,
      CRITERIA,
      WORK_DURATION.toString(),
      AMOUNT.toString(),
      toHex(account.termsHash),
    ],
  );
  chain.setTask(taskAddress, account, { finalized: true });
  const submissionId = await register(taskId, account, options.nonce ?? account.submissionNonce);
  return { taskId, address: taskAddress, submissionId };
}

async function register(taskId: string, account: TaskAccount, nonce: bigint): Promise<string> {
  const submission = await owner.query<{ id: string }>(
    `INSERT INTO submissions (task_id, submission_nonce, evidence_hash, pr_number, submitter_wallet)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      taskId,
      nonce.toString(),
      toHex(account.evidenceHash),
      PR_NUMBER.toString(),
      DEVELOPER.toBase58(),
    ],
  );
  const id = submission.rows[0]?.id ?? '';
  await owner.query(`INSERT INTO verification_jobs (submission_id, run_after) VALUES ($1, $2)`, [
    id,
    new Date(clock),
  ]);
  return id;
}

interface ResultRow {
  status: string;
  rules: { rule: string; passed: boolean | null }[];
  head_sha: string | null;
  merge_commit_sha: string | null;
  pr_author_login: string | null;
  merged_by_login: string | null;
  recomputed_evidence_hash: string | null;
  onchain_evidence_hash: string | null;
  attester_pubkey: string;
  github_meta: { calls: { endpoint: string }[] };
}

async function results(submissionId: string): Promise<ResultRow[]> {
  const rows = await owner.query<ResultRow>(
    `SELECT * FROM verification_results WHERE submission_id = $1 ORDER BY id`,
    [submissionId],
  );
  return rows.rows;
}

interface AttestationRow {
  status: string;
  signature: string | null;
  attempts: number;
  last_error: string | null;
}

async function attestation(submissionId: string): Promise<AttestationRow | undefined> {
  const rows = await owner.query<AttestationRow>(
    `SELECT status, signature, attempts, last_error FROM attestations WHERE submission_id = $1`,
    [submissionId],
  );
  return rows.rows[0];
}

async function job(
  submissionId: string,
): Promise<{ status: string; attempts: number; run_after: Date }> {
  const rows = await owner.query<{ status: string; attempts: number; run_after: Date }>(
    `SELECT status, attempts, run_after FROM verification_jobs WHERE submission_id = $1`,
    [submissionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('job is missing');
  return row;
}

function requeue(submissionId: string): Promise<unknown> {
  return owner.query(
    `UPDATE verification_jobs SET status = 'QUEUED', run_after = $2 WHERE submission_id = $1`,
    [submissionId, new Date(clock)],
  );
}

describe('a valid submission', () => {
  it('is VERIFIED, audited with both SHAs, and attested exactly once', async () => {
    const s = await seed();
    await worker.tick();

    const [result, ...more] = await results(s.submissionId);
    expect(more).toEqual([]);
    expect(result).toMatchObject({
      status: 'VERIFIED',
      head_sha: HEAD_SHA,
      merge_commit_sha: MERGE_SHA,
      pr_author_login: 'dev-octocat',
      merged_by_login: 'maintainer',
      attester_pubkey: keypair.publicKey.toBase58(),
    });
    expect(result?.recomputed_evidence_hash).toBe(result?.onchain_evidence_hash);
    expect(result?.rules.every((rule) => rule.passed === true)).toBe(true);
    expect(result?.github_meta.calls).toHaveLength(1);

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({
      signer: keypair.publicKey.toBase58(),
      task: s.address.toBase58(),
      submissionNonce: 1n,
    });
    expect(chain.taskAt(s.address, 'confirmed')?.state).toBe('UNDER_REVIEW');
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'SENT',
      signature: chain.sent[0]?.signature,
      attempts: 1,
    });
    expect((await job(s.submissionId)).status).toBe('DONE');

    // Confirmed is not final: the record becomes FINALIZED only with the chain.
    await worker.tick();
    expect((await attestation(s.submissionId))?.status).toBe('SENT');
    chain.finalize();
    await worker.tick();
    expect((await attestation(s.submissionId))?.status).toBe('FINALIZED');
    expect(chain.sent).toHaveLength(1);
  });

  it('is not attested twice when the job is delivered again or replayed', async () => {
    const s = await seed();
    await worker.tick();
    chain.finalize();
    await worker.tick();

    for (let replay = 0; replay < 3; replay += 1) {
      await requeue(s.submissionId);
      await worker.tick();
    }
    expect(chain.sent).toHaveLength(1);
    expect(await results(s.submissionId)).toHaveLength(1);
    expect((await job(s.submissionId)).status).toBe('DONE');
  });

  it('is processed once by two workers racing for the same job', async () => {
    const s = await seed();
    await Promise.all([worker.tick(), newWorker().tick(), newWorker().tick()]);
    expect((await results(s.submissionId)).filter((row) => row.status === 'VERIFIED')).toHaveLength(
      1,
    );
    const attested = await owner.query(`SELECT 1 FROM attestations WHERE submission_id = $1`, [
      s.submissionId,
    ]);
    expect(attested.rowCount).toBe(1);
    expect(chain.sent.filter((sent) => sent.task === s.address.toBase58())).toHaveLength(1);
  });
});

describe('a submission that fails verification', () => {
  it.each([
    [
      'an unmerged pull request',
      () => ok(mergedPullRequest({ merged: false, mergedAt: null })),
      'R4',
    ],
    [
      'a self-merge',
      () => ok(mergedPullRequest({ mergedBy: { id: DEVELOPER_GITHUB_ID, login: 'dev-octocat' } })),
      'R6',
    ],
    ['a force-pushed head', () => ok(mergedPullRequest({ headSha: 'f'.repeat(40) })), 'R9'],
    ['a pull request that does not exist', () => notFound(), 'R1'],
  ])('is REJECTED for %s and never attested', async (_, outcome, rule) => {
    const s = await seed();
    github.pullRequest = outcome();
    github.repository = ok({ fullName: REPO, createdAt: '2020-01-01T00:00:00Z' });
    await worker.tick();

    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(
      result?.rules.filter((entry) => entry.passed === false).map((entry) => entry.rule),
    ).toEqual([rule]);
    expect(await attestation(s.submissionId)).toBeUndefined();
    expect(chain.sent).toEqual([]);
    expect((await job(s.submissionId)).status).toBe('DONE');
  });

  it('is REJECTED when the repository was deleted', async () => {
    const s = await seed();
    github.pullRequest = notFound();
    github.repository = notFound();
    await worker.tick();
    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(result?.github_meta.calls).toHaveLength(2);
    expect(github.calls).toEqual([`pull ${REPO}#42`, `repo ${REPO}`]);
  });

  it('is REJECTED without contacting GitHub when metadata does not match the on-chain terms', async () => {
    const s = await seed({ repo: 'attacker/repo' });
    await worker.tick();
    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(result?.rules).toEqual([expect.objectContaining({ rule: 'P1', passed: false })]);
    expect(github.calls).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it('can be verified later when the developer asks again after the merge', async () => {
    const s = await seed();
    github.pullRequest = ok(mergedPullRequest({ merged: false, mergedAt: null, mergedBy: null }));
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual(['REJECTED']);

    github.pullRequest = ok(mergedPullRequest());
    await requeue(s.submissionId);
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual([
      'REJECTED',
      'VERIFIED',
    ]);
    expect(chain.sent).toHaveLength(1);
  });
});

describe('stale and replayed submissions', () => {
  it('rejects a job for a submission that was superseded on-chain', async () => {
    const s = await seed();
    chain.setTask(
      s.address,
      submittedTask({ submissionNonce: 2n, evidenceHash: new Uint8Array(32).fill(0x22) }),
      { finalized: true },
    );
    await worker.tick();
    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(result?.rules.at(-1)).toMatchObject({ rule: 'P2', passed: false });
    expect(chain.sent).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it('waits, without a verdict, while the submission is confirmed but not finalized', async () => {
    const s = await seed({ account: { submissionNonce: 0n, state: 'ACCEPTED' }, nonce: 1n });
    chain.setTask(s.address, submittedTask(), { finalized: false });
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual(['PENDING']);
    expect(chain.sent).toEqual([]);
    expect((await job(s.submissionId)).status).toBe('QUEUED');

    chain.finalize();
    clock += backoffSeconds(1) * 1000;
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual([
      'PENDING',
      'VERIFIED',
    ]);
  });

  it('does nothing for a task that is already attested for this submission', async () => {
    const account = submittedTask();
    const s = await seed({
      account: {
        state: 'UNDER_REVIEW',
        attestedHash: account.evidenceHash,
        attestedNonce: 1n,
        verifiedAt: 1_760_001_900n,
      },
    });
    await worker.tick();
    expect(await results(s.submissionId)).toEqual([]);
    expect(chain.sent).toEqual([]);
    expect((await job(s.submissionId)).status).toBe('DONE');
  });

  it('rejects after the verification deadline', async () => {
    const s = await seed();
    chain.time = VERIFICATION_DEADLINE + 1n;
    await worker.tick();
    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(result?.rules.at(-1)).toMatchObject({ rule: 'P3', passed: false });
  });
});

describe('GitHub failures', () => {
  it('produce PENDING with backoff, and VERIFIED once GitHub answers', async () => {
    const s = await seed();
    github.pullRequest = unavailable('GitHub did not answer in time');
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual(['PENDING']);
    const queued = await job(s.submissionId);
    expect(queued).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(queued.run_after.getTime()).toBe(clock + backoffSeconds(1) * 1000);

    // Not due yet: nothing happens.
    await worker.tick();
    expect(await results(s.submissionId)).toHaveLength(1);

    clock += backoffSeconds(1) * 1000;
    github.pullRequest = unavailable('GitHub answered 403');
    await worker.tick();
    clock += backoffSeconds(2) * 1000;
    github.pullRequest = ok(mergedPullRequest());
    await worker.tick();

    expect((await results(s.submissionId)).map((row) => row.status)).toEqual([
      'PENDING',
      'PENDING',
      'VERIFIED',
    ]);
    expect(chain.sent).toHaveLength(1);
  });

  it('never turn into VERIFIED or an attestation, however long they last', async () => {
    const s = await seed();
    github.pullRequest = unavailable('GitHub answered 503');
    for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
      await worker.tick();
      clock += backoffSeconds(attempt) * 1000;
    }
    const all = await results(s.submissionId);
    expect(all).toHaveLength(MAX_VERIFICATION_ATTEMPTS);
    expect(new Set(all.map((row) => row.status))).toEqual(new Set(['PENDING']));
    expect(await job(s.submissionId)).toMatchObject({ status: 'DONE' });
    expect(chain.sent).toEqual([]);
  });

  it('backs off from 5 seconds to at most 5 minutes', () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffSeconds)).toEqual([5, 10, 20, 40, 300, 300]);
  });
});

describe('RPC failures', () => {
  it('leave no verdict and retry the job', async () => {
    const s = await seed();
    chain.available = false;
    await worker.tick();
    expect(await results(s.submissionId)).toEqual([]);
    expect((await job(s.submissionId)).status).toBe('QUEUED');

    chain.available = true;
    clock += backoffSeconds(1) * 1000;
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual(['VERIFIED']);
  });
});

describe('attestation delivery', () => {
  it('re-sends a transaction the cluster never included, and records it once', async () => {
    const s = await seed();
    chain.sendMode = 'drop';
    await worker.tick();
    const first = await attestation(s.submissionId);
    expect(first).toMatchObject({ status: 'SENT', attempts: 1 });

    // Before the blockhash can have expired, nothing is re-sent.
    clock += RESEND_AFTER_MS - 1_000;
    await worker.tick();
    expect(chain.sent).toHaveLength(1);

    clock += 2_000;
    chain.sendMode = 'land';
    await worker.tick();
    const second = await attestation(s.submissionId);
    expect(second).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(second?.signature).not.toBe(first?.signature);

    chain.finalize();
    await worker.tick();
    expect((await attestation(s.submissionId))?.status).toBe('FINALIZED');
    expect(chain.taskAt(s.address, 'finalized')?.attestedNonce).toBe(1n);
  });

  it('keeps the request when the RPC endpoint refuses the send, and delivers it later', async () => {
    const s = await seed();
    chain.sendMode = 'reject';
    await worker.tick();
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'SENT',
      last_error: 'The RPC endpoint did not accept the transaction.',
    });
    expect(chain.sent).toEqual([]);

    chain.sendMode = 'land';
    clock += RESEND_AFTER_MS + 1_000;
    await worker.tick();
    chain.finalize();
    await worker.tick();
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'FINALIZED',
      last_error: null,
    });
  });

  it('recovers a request that was recorded but never sent (crash before send)', async () => {
    const s = await seed();
    // The verdict and the request are written; the process stops before sending.
    await worker.processNextJob();
    expect((await attestation(s.submissionId))?.status).toBe('REQUESTED');
    expect(chain.sent).toEqual([]);

    // A fresh process picks the request up.
    await newWorker().driveAttestations();
    expect((await attestation(s.submissionId))?.status).toBe('SENT');
    expect(chain.sent).toHaveLength(1);
  });

  it('gives up after a bounded number of sends', async () => {
    const s = await seed();
    chain.sendMode = 'drop';
    for (let attempt = 0; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      await worker.tick();
      clock += RESEND_AFTER_MS + 1_000;
    }
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'FAILED',
      attempts: MAX_SEND_ATTEMPTS,
    });
    expect(chain.sent).toHaveLength(MAX_SEND_ATTEMPTS);
  });

  it('fails the request when the developer resubmits before it lands', async () => {
    const s = await seed();
    chain.sendMode = 'drop';
    await worker.tick();
    chain.setTask(
      s.address,
      submittedTask({ submissionNonce: 2n, evidenceHash: new Uint8Array(32).fill(0x33) }),
      { finalized: true },
    );
    await worker.tick();
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'FAILED',
      last_error: 'The submission is no longer the current one on-chain.',
    });
    expect(chain.sent).toHaveLength(1);
  });

  it('fails the request when the verification deadline passes first', async () => {
    const s = await seed();
    chain.sendMode = 'drop';
    await worker.tick();
    chain.time = VERIFICATION_DEADLINE + 1n;
    await worker.tick();
    expect((await attestation(s.submissionId))?.last_error).toMatch(/verification deadline/);
  });

  it('fails the request when the key is no longer the platform attester', async () => {
    const s = await seed();
    chain.sendMode = 'drop';
    await worker.tick();
    const sent = await attestation(s.submissionId);
    chain.failOnChain(sent?.signature ?? '', 'Unauthorized');
    await worker.tick();
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'FAILED',
      last_error: 'record_attestation failed on-chain with Unauthorized.',
    });
  });

  it('reports a preflight refusal by name and never marks it delivered', async () => {
    const s = await seed();
    chain.platformAttester = key(88); // the key was rotated away
    await worker.tick();
    expect(await attestation(s.submissionId)).toMatchObject({
      status: 'SENT',
      last_error: 'Preflight failed with Unauthorized.',
    });
    expect(chain.taskAt(s.address, 'confirmed')?.state).toBe('SUBMITTED');
  });
});
