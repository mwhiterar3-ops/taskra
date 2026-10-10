// The attestation service end to end against a real database: a queued job
// becomes an audit record and, only when VERIFIED, exactly one attestation.

import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createTaskraConfig, type TaskAccount, taskIdFromUuid, toHex } from '@taskra/sdk';
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
  headCommit,
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
  // As on-chain: the account carries the id its record is stored under.
  const account = submittedTask({ taskId: taskIdFromUuid(taskId), ...options.account });
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
  // By default the pull request's head commit declares this task and this developer.
  github.commit = ok(headCommit(taskId));
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
    expect(result?.github_meta.calls).toHaveLength(2);
    expect(github.calls).toEqual([`pull ${REPO}#42`, `commit ${REPO}@${HEAD_SHA.slice(0, 7)}`]);

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

  // M-01: an unrelated pull request that passes every pre-existing rule.
  it('is REJECTED for an unrelated merged pull request, and nothing is signed', async () => {
    const s = await seed();
    github.commit = ok({ sha: HEAD_SHA, message: 'Fix a typo in the README' });
    await worker.tick();

    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    const byRule = new Map(result?.rules.map((entry) => [entry.rule, entry.passed]));
    for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']) {
      expect(byRule.get(rule), rule).toBe(true);
    }
    expect(byRule.get('R11')).toBe(false);
    expect(byRule.get('R12')).toBe(false);
    expect(await attestation(s.submissionId)).toBeUndefined();
    expect(chain.sent).toEqual([]);
    expect(chain.taskAt(s.address, 'confirmed')?.state).toBe('SUBMITTED');
  });

  it('lets one pull request satisfy only the task its commit names', async () => {
    const first = await seed();
    const second = await seed();
    // Both tasks claim pull request #42; its head commit names the first.
    github.commit = ok(headCommit(first.taskId));
    await worker.tick();

    expect((await results(first.submissionId)).map((row) => row.status)).toEqual(['VERIFIED']);
    const [other] = await results(second.submissionId);
    expect(other?.status).toBe('REJECTED');
    expect(
      other?.rules.filter((entry) => entry.passed === false).map((entry) => entry.rule),
    ).toEqual(['R11']);
    expect(chain.sent.map((sent) => sent.task)).toEqual([first.address.toBase58()]);
  });

  // The id R11 compares the commit with is the database record's. A record
  // whose address is another task's account would let that task be attested
  // with a pull request made for this one.
  it('is REJECTED without contacting GitHub when the account at the stored address is another task', async () => {
    const named = randomUUID();
    const s = await seed({ account: { taskId: taskIdFromUuid(named) } });
    // The commit names the record's id, so R11 alone would pass.
    github.commit = ok(headCommit(s.taskId));
    await worker.tick();

    const [result] = await results(s.submissionId);
    expect(result?.status).toBe('REJECTED');
    expect(result?.rules).toEqual([expect.objectContaining({ rule: 'P1', passed: false })]);
    expect(github.calls).toEqual([]);
    expect(await attestation(s.submissionId)).toBeUndefined();
    expect(chain.sent).toEqual([]);
  });

  // M-03: someone who can write the database links the author's GitHub account
  // to their own wallet and claims the author's pull request.
  it('is REJECTED when a rewritten GitHub link is the only thing tying the wallet to the pull request', async () => {
    const attacker = key(66);
    await owner.query(`INSERT INTO wallets (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      attacker.toBase58(),
    ]);
    await owner.query(`UPDATE github_accounts SET wallet = $1 WHERE github_user_id = $2`, [
      attacker.toBase58(),
      DEVELOPER_GITHUB_ID,
    ]);
    try {
      // The attacker's wallet is the task's on-chain developer.
      const s = await seed({ account: { developer: attacker } });
      // The real author's commit names the task, and their own wallet as payee.
      github.commit = ok(headCommit(s.taskId, DEVELOPER.toBase58()));
      await worker.tick();

      const [result] = await results(s.submissionId);
      expect(result?.status).toBe('REJECTED');
      const failedRules = result?.rules.filter((entry) => entry.passed === false);
      // R5 is satisfied by the forged link. R12 is what stops it.
      expect(failedRules?.map((entry) => entry.rule)).toEqual(['R12']);
      expect(chain.sent).toEqual([]);
    } finally {
      await owner.query(`UPDATE github_accounts SET wallet = $1 WHERE github_user_id = $2`, [
        DEVELOPER.toBase58(),
        DEVELOPER_GITHUB_ID,
      ]);
    }
  });

  it('is PENDING while the head commit cannot be read, then decided', async () => {
    const s = await seed();
    const good = github.commit;
    github.commit = unavailable('GitHub answered 502');
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual(['PENDING']);
    expect(chain.sent).toEqual([]);

    github.commit = good;
    clock += backoffSeconds(1) * 1000;
    await worker.tick();
    expect((await results(s.submissionId)).map((row) => row.status)).toEqual([
      'PENDING',
      'VERIFIED',
    ]);
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
      submittedTask({
        taskId: taskIdFromUuid(s.taskId),
        submissionNonce: 2n,
        evidenceHash: new Uint8Array(32).fill(0x22),
      }),
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
    chain.setTask(s.address, submittedTask({ taskId: taskIdFromUuid(s.taskId) }), {
      finalized: false,
    });
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

// N-2 of the second review: the developer corrects the registered pull-request
// number while the service is asking GitHub about the old one.
describe('a registration corrected while it is being verified', () => {
  interface Records {
    registered: string;
    job: string;
    verified: string[] | null;
    attested: string[] | null;
  }

  async function records(submissionId: string): Promise<Records | undefined> {
    const result = await owner.query<Records>(
      `SELECT s.pr_number AS registered,
              (SELECT status FROM verification_jobs j WHERE j.submission_id = s.id) AS job,
              (SELECT array_agg(r.pr_number::text) FROM verification_results r
                WHERE r.submission_id = s.id AND r.status = 'VERIFIED') AS verified,
              (SELECT array_agg(r.pr_number::text) FROM attestations a
                 JOIN verification_results r ON r.id = a.verification_result_id
                WHERE a.submission_id = s.id) AS attested
         FROM submissions s WHERE s.id = $1`,
      [submissionId],
    );
    return result.rows[0];
  }

  it('records no VERIFIED result and signs nothing for the old number, then recovers', async () => {
    const s = await seed();
    const api = createPool(database.url, 'taskra_api');
    try {
      // The race found in the review: the correction commits after the service
      // has read #42 and before it records its verdict.
      const original = github.getPullRequest.bind(github);
      let corrections = 0;
      github.getPullRequest = async (repo, number) => {
        if (corrections === 0) {
          const update = await api.query(`UPDATE submissions SET pr_number = 4242 WHERE id = $1`, [
            s.submissionId,
          ]);
          corrections += update.rowCount ?? 0;
        }
        return original(repo, number);
      };

      await worker.processNextJob();
      expect(corrections).toBe(1);
      // Everything about #42 checked out, and still nothing was recorded for it.
      expect(await records(s.submissionId)).toEqual({
        registered: '4242',
        job: 'QUEUED',
        verified: null,
        attested: null,
      });
      await worker.driveAttestations();
      expect(chain.sent).toHaveLength(0);

      // The retry verifies what is registered now. The on-chain hash was made
      // for #42, so #4242 is rejected on R9.
      clock += 60_000;
      await worker.processNextJob();
      const rejected = (await results(s.submissionId)).at(-1);
      expect(rejected?.status).toBe('REJECTED');
      expect(rejected?.rules.find((rule) => rule.rule === 'R9')?.passed).toBe(false);
      expect((await records(s.submissionId))?.verified).toBeNull();

      // Not stuck on the wrong number: the developer corrects it back.
      await api.query(`UPDATE submissions SET pr_number = $2 WHERE id = $1`, [
        s.submissionId,
        PR_NUMBER.toString(),
      ]);
      await api.query(
        `UPDATE verification_jobs SET status = 'QUEUED', attempts = 0, run_after = $2
          WHERE submission_id = $1`,
        [s.submissionId, new Date(clock)],
      );
      await worker.tick();
      expect(await records(s.submissionId)).toEqual({
        registered: PR_NUMBER.toString(),
        job: 'DONE',
        verified: [PR_NUMBER.toString()],
        attested: [PR_NUMBER.toString()],
      });
      expect(chain.sent).toHaveLength(1);
    } finally {
      await api.end();
    }
  });

  it('refuses the correction once the VERIFIED result is recorded', async () => {
    const s = await seed();
    const api = createPool(database.url, 'taskra_api');
    try {
      await worker.processNextJob();
      await expect(
        api.query(`UPDATE submissions SET pr_number = 4242 WHERE id = $1`, [s.submissionId]),
      ).rejects.toThrow(/cannot be pointed at another pull request/);
      expect(await records(s.submissionId)).toMatchObject({
        registered: PR_NUMBER.toString(),
        verified: [PR_NUMBER.toString()],
        attested: [PR_NUMBER.toString()],
      });
    } finally {
      await api.end();
    }
  });
});
