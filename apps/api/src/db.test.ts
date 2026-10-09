// The schema's own guarantees (docs/04-DATABASE-SPEC.md), tested directly
// against PostgreSQL: privileges per role, append-only audit rows, and the
// constraints that make duplicate settlements and attestations impossible.

import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '@taskra/shared/db';
import { type TestDatabase, testDatabase } from '@taskra/shared/testing/postgres';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const WALLET = '4Nd1mYw3rRkq7oXWcQ9o6yq6mXoV1mQbJ9g3M9xA5hQz';
const OTHER_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const HASH = 'ab'.repeat(32);
const SHA = 'cd'.repeat(20);

let database: TestDatabase;
let owner: pg.Pool;
let api: pg.Pool;
let attester: pg.Pool;

beforeAll(async () => {
  database = await testDatabase();
  owner = new pg.Pool({ connectionString: database.url, max: 2 });
  api = createPool(database.url, 'taskra_api');
  attester = createPool(database.url, 'taskra_attester');
});
afterAll(async () => {
  await Promise.all([owner.end(), api.end(), attester.end()]);
  await database.drop();
});

function signature(): string {
  // 64 base58 characters: shape only.
  return randomBytes(48)
    .toString('hex')
    .replaceAll(/[0OIl]/g, 'a')
    .slice(0, 64);
}

interface Fixture {
  taskId: string;
  submissionId: string;
}

/** A task with one submission, written as the owner. */
async function fixture(): Promise<Fixture> {
  await owner.query(`INSERT INTO wallets (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
    WALLET,
    OTHER_WALLET,
  ]);
  const taskId = randomUUID();
  // The address only has to be unique and well-formed here.
  const address = `T${randomBytes(24)
    .toString('hex')
    .replaceAll(/[0OIl]/g, 'a')}`.slice(0, 44);
  await owner.query(
    `INSERT INTO tasks (id, client_wallet, task_address, title, description, repo,
            acceptance_criteria, work_duration, amount, terms_hash)
     VALUES ($1, $2, $3, 'title', '', 'a/b', 'criteria', 60, 100, $4)`,
    [taskId, WALLET, address, HASH],
  );
  const submission = await owner.query<{ id: string }>(
    `INSERT INTO submissions (task_id, submission_nonce, evidence_hash, pr_number, submitter_wallet)
     VALUES ($1, 1, $2, 42, $3) RETURNING id`,
    [taskId, HASH, OTHER_WALLET],
  );
  return { taskId, submissionId: submission.rows[0]?.id ?? '' };
}

async function insertResult(
  db: pg.Pool,
  submissionId: string,
  status: 'PENDING' | 'VERIFIED' | 'REJECTED',
  onchainHash = HASH,
): Promise<string> {
  const verified = status === 'VERIFIED';
  const result = await db.query<{ id: string }>(
    `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
            verifier_version, attester_pubkey, repo, pr_number, head_sha, merge_commit_sha,
            pr_author_id, pr_author_login, merged_by_id, merged_by_login, merged_at,
            repo_created_at, recomputed_evidence_hash, onchain_evidence_hash,
            onchain_submission_nonce, github_meta)
     VALUES ($1, $2, '[]', 'v1', 'test', $3, 'a/b', 42, $4, $4, $5, 'dev', $6, 'maintainer',
             $7, $7, $8, $9, 1, '{}')
     RETURNING id`,
    [
      submissionId,
      status,
      WALLET,
      verified ? SHA : null,
      verified ? 1 : null,
      verified ? 2 : null,
      verified ? new Date() : null,
      verified ? onchainHash : null,
      onchainHash,
    ],
  );
  return result.rows[0]?.id ?? '';
}

function insertAttestation(db: pg.Pool, f: Fixture, resultId: string, hash = HASH) {
  return db.query(
    `INSERT INTO attestations (submission_id, verification_result_id, task_id, evidence_hash,
            submission_nonce, attester_pubkey)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [f.submissionId, resultId, f.taskId, hash, WALLET],
  );
}

const DENIED = /permission denied/;

describe('migrations', () => {
  it('apply from an empty database and are recorded', async () => {
    const applied = await owner.query<{ name: string }>('SELECT name FROM pgmigrations');
    expect(applied.rows.map((row) => row.name)).toEqual(['1760000000000_initial-schema']);
    const tables = await owner.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'attestations',
      'auth_nonces',
      'github_accounts',
      'github_oauth_states',
      'onchain_transactions',
      'pgmigrations',
      'rejection_reasons',
      'sessions',
      'settlements',
      'submissions',
      'tasks',
      'verification_jobs',
      'verification_results',
      'wallets',
    ]);
  });

  it('roll back and re-apply cleanly on an empty database', async () => {
    const scratch = await testDatabase();
    try {
      const options = {
        databaseUrl: scratch.url,
        dir: MIGRATIONS,
        migrationsTable: 'pgmigrations',
        log: () => undefined,
      };
      await runner({ ...options, direction: 'down', count: 1 });
      const client = new pg.Client({ connectionString: scratch.url });
      await client.connect();
      const afterDown = await client.query(
        `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
      );
      expect(afterDown.rowCount).toBe(0);
      await runner({ ...options, direction: 'up' });
      const afterUp = await client.query(`SELECT 1 FROM pg_tables WHERE tablename = 'settlements'`);
      expect(afterUp.rowCount).toBe(1);
      await client.end();
    } finally {
      await scratch.drop();
    }
  });
});

describe('the API role', () => {
  it('runs as taskra_api', async () => {
    const role = await api.query<{ current_user: string }>('SELECT current_user');
    expect(role.rows[0]?.current_user).toBe('taskra_api');
  });

  it('cannot write verification results or attestations', async () => {
    const f = await fixture();
    await expect(insertResult(api, f.submissionId, 'VERIFIED')).rejects.toThrow(DENIED);
    const resultId = await insertResult(owner, f.submissionId, 'VERIFIED');
    await expect(insertAttestation(api, f, resultId)).rejects.toThrow(DENIED);
    await insertAttestation(owner, f, resultId);
    await expect(api.query(`UPDATE attestations SET status = 'FINALIZED'`)).rejects.toThrow(DENIED);
    await expect(api.query(`DELETE FROM verification_results`)).rejects.toThrow(DENIED);
    // It can read both, to show them.
    expect((await api.query('SELECT status FROM attestations')).rowCount).toBeGreaterThan(0);
  });

  it('cannot change task metadata, only the chain cache', async () => {
    const f = await fixture();
    await expect(
      api.query(`UPDATE tasks SET title = 'changed' WHERE id = $1`, [f.taskId]),
    ).rejects.toThrow(DENIED);
    await expect(
      api.query(`UPDATE tasks SET amount = 1, terms_hash = $2 WHERE id = $1`, [f.taskId, HASH]),
    ).rejects.toThrow(DENIED);
    await expect(api.query(`DELETE FROM tasks WHERE id = $1`, [f.taskId])).rejects.toThrow(DENIED);
    const cache = await api.query(
      `UPDATE tasks SET chain_state = 'OPEN', chain_slot = 5, chain_commitment = 'confirmed'
        WHERE id = $1`,
      [f.taskId],
    );
    expect(cache.rowCount).toBe(1);
  });

  it('cannot rewrite or delete settlements, transactions or submissions', async () => {
    await expect(api.query(`UPDATE settlements SET fee_amount = 0`)).rejects.toThrow(DENIED);
    await expect(api.query(`DELETE FROM settlements`)).rejects.toThrow(DENIED);
    await expect(api.query(`DELETE FROM onchain_transactions`)).rejects.toThrow(DENIED);
    await expect(api.query(`UPDATE submissions SET pr_number = 1`)).rejects.toThrow(DENIED);
  });
});

describe('the attester role', () => {
  it('reads what it verifies and nothing about sessions', async () => {
    await fixture();
    expect((await attester.query('SELECT id FROM tasks')).rowCount).toBeGreaterThan(0);
    await expect(attester.query('SELECT * FROM sessions')).rejects.toThrow(DENIED);
    await expect(attester.query('SELECT * FROM auth_nonces')).rejects.toThrow(DENIED);
  });

  it('cannot change tasks, submissions, links or settlements', async () => {
    await expect(attester.query(`UPDATE tasks SET chain_state = 'SETTLED'`)).rejects.toThrow(
      DENIED,
    );
    await expect(attester.query(`UPDATE submissions SET pr_number = 1`)).rejects.toThrow(DENIED);
    await expect(attester.query(`DELETE FROM github_accounts`)).rejects.toThrow(DENIED);
    await expect(attester.query(`SELECT * FROM settlements`)).rejects.toThrow(DENIED);
  });
});

describe('a dedicated login that is a member of taskra_api only', () => {
  it('cannot assume the attester role or escape its own', async () => {
    const login = `api_login_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE taskra_api`);
    const url = new URL(database.url);
    url.username = login;
    url.password = password;
    const restricted = createPool(url.toString(), 'taskra_api');
    try {
      const f = await fixture();
      const client = await restricted.connect();
      try {
        await expect(client.query('SET ROLE taskra_attester')).rejects.toThrow(DENIED);
        await client.query('RESET ROLE');
        await expect(insertResultWith(client, f.submissionId)).rejects.toThrow(DENIED);
        await expect(client.query(`UPDATE tasks SET title = 'x'`)).rejects.toThrow(DENIED);
      } finally {
        client.release();
      }
    } finally {
      await restricted.end();
      await owner.query(
        `REVOKE ALL PRIVILEGES ON DATABASE "${url.pathname.slice(1)}" FROM ${login}`,
      );
      await owner.query(`DROP ROLE ${login}`);
    }
  });
});

function insertResultWith(client: pg.PoolClient, submissionId: string) {
  return client.query(
    `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
            verifier_version, attester_pubkey, repo, pr_number, github_meta)
     VALUES ($1, 'REJECTED', '[]', 'v1', 'test', $2, 'a/b', 42, '{}')`,
    [submissionId, WALLET],
  );
}

describe('verification results', () => {
  it('are append-only, even for the database owner', async () => {
    const f = await fixture();
    await insertResult(owner, f.submissionId, 'REJECTED');
    await expect(
      owner.query(`UPDATE verification_results SET status = 'VERIFIED' WHERE submission_id = $1`, [
        f.submissionId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(`DELETE FROM verification_results WHERE submission_id = $1`, [f.submissionId]),
    ).rejects.toThrow(/append-only/);
  });

  it('allow at most one VERIFIED result per submission', async () => {
    const f = await fixture();
    await insertResult(attester, f.submissionId, 'PENDING');
    await insertResult(attester, f.submissionId, 'VERIFIED');
    await expect(insertResult(attester, f.submissionId, 'VERIFIED')).rejects.toThrow(
      /verification_results_one_verified_idx/,
    );
  });

  it('refuse a VERIFIED result without the full audit record', async () => {
    const f = await fixture();
    await expect(
      attester.query(
        `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
                verifier_version, attester_pubkey, repo, pr_number, github_meta)
         VALUES ($1, 'VERIFIED', '[]', 'v1', 'test', $2, 'a/b', 42, '{}')`,
        [f.submissionId, WALLET],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});

describe('attestations', () => {
  it('require a VERIFIED result for exactly that submission, hash and nonce', async () => {
    const f = await fixture();
    const rejected = await insertResult(attester, f.submissionId, 'REJECTED');
    await expect(insertAttestation(attester, f, rejected)).rejects.toThrow(/VERIFIED result/);

    const other = await fixture();
    const otherVerified = await insertResult(attester, other.submissionId, 'VERIFIED');
    await expect(insertAttestation(attester, f, otherVerified)).rejects.toThrow(/VERIFIED result/);

    const verified = await insertResult(attester, f.submissionId, 'VERIFIED');
    await expect(insertAttestation(attester, f, verified, 'ef'.repeat(32))).rejects.toThrow(
      /VERIFIED result/,
    );
    await insertAttestation(attester, f, verified);
  });

  it('exist at most once per submission', async () => {
    const f = await fixture();
    const verified = await insertResult(attester, f.submissionId, 'VERIFIED');
    await insertAttestation(attester, f, verified);
    await expect(insertAttestation(attester, f, verified)).rejects.toThrow(/attestations_pkey/);
  });

  it('cannot be re-pointed, and a final status stays final', async () => {
    const f = await fixture();
    const verified = await insertResult(attester, f.submissionId, 'VERIFIED');
    await insertAttestation(attester, f, verified);
    const where = [f.submissionId];
    await expect(
      attester.query(`UPDATE attestations SET evidence_hash = $2 WHERE submission_id = $1`, [
        f.submissionId,
        'ef'.repeat(32),
      ]),
    ).rejects.toThrow(/re-pointed/);
    await expect(
      attester.query(`UPDATE attestations SET status = 'SENT' WHERE submission_id = $1`, where),
    ).rejects.toThrow(/violates check constraint/);
    await attester.query(
      `UPDATE attestations SET status = 'FINALIZED', signature = $2 WHERE submission_id = $1`,
      [f.submissionId, signature()],
    );
    await expect(
      attester.query(`UPDATE attestations SET status = 'FAILED' WHERE submission_id = $1`, where),
    ).rejects.toThrow(/is final/);
  });
});

describe('financial constraints', () => {
  it('store amounts as exact u64 base units', async () => {
    const f = await fixture();
    await expect(
      owner.query(`UPDATE tasks SET amount = 18446744073709551616 WHERE id = $1`, [f.taskId]),
    ).rejects.toThrow(/token_amount/);
    await expect(
      owner.query(`UPDATE tasks SET amount = 0 WHERE id = $1`, [f.taskId]),
    ).rejects.toThrow(/violates check constraint/);
    await owner.query(`UPDATE tasks SET amount = 18446744073709551615 WHERE id = $1`, [f.taskId]);
    const read = await owner.query<{ amount: string }>(`SELECT amount FROM tasks WHERE id = $1`, [
      f.taskId,
    ]);
    // Returned as a string: no precision is lost in JavaScript.
    expect(read.rows[0]?.amount).toBe('18446744073709551615');
  });

  it('allow one settlement per task and per transaction', async () => {
    const first = await fixture();
    const second = await fixture();
    const sig = signature();
    const settle = (taskId: string, txSignature: string) =>
      owner.query(
        `INSERT INTO settlements (task_id, signature, state, outcome, client_wallet, amount,
                fee_amount, developer_amount, client_amount, disputed, closed_at, slot)
         VALUES ($1, $2, 'CANCELLED', 'CANCELLED', $3, 100, 0, 0, 100, false, now(), 1)`,
        [taskId, txSignature, WALLET],
      );
    for (const [taskId, txSignature] of [
      [first.taskId, sig],
      [second.taskId, signature()],
    ] as const) {
      await owner.query(
        `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot)
         VALUES ($1, $2, 'cancel_task', 'FINALIZED', 1)`,
        [txSignature, taskId],
      );
    }
    await settle(first.taskId, sig);
    await expect(settle(first.taskId, sig)).rejects.toThrow(/settlements_pkey/);
    await expect(settle(second.taskId, sig)).rejects.toThrow(/settlements_signature_key/);
  });

  it('refuse a settlement that pays a developer without being SETTLED', async () => {
    const f = await fixture();
    const sig = signature();
    await owner.query(
      `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot)
       VALUES ($1, $2, 'cancel_task', 'FINALIZED', 1)`,
      [sig, f.taskId],
    );
    await expect(
      owner.query(
        `INSERT INTO settlements (task_id, signature, state, outcome, client_wallet, amount,
                fee_amount, developer_amount, client_amount, disputed, closed_at, slot)
         VALUES ($1, $2, 'REFUNDED', 'NEVER_VERIFIED', $3, 100, 0, 50, 50, false, now(), 1)`,
        [f.taskId, sig, WALLET],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});
