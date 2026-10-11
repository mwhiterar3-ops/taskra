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
import { assertConfinedDatabaseLogin } from './startup.js';

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

type Database = pg.Pool | pg.PoolClient;

async function insertResult(
  db: Database,
  submissionId: string,
  status: 'PENDING' | 'VERIFIED' | 'REJECTED',
  onchainHash = HASH,
  prNumber = 42,
): Promise<string> {
  const verified = status === 'VERIFIED';
  const result = await db.query<{ id: string }>(
    `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
            verifier_version, attester_pubkey, repo, pr_number, head_sha, merge_commit_sha,
            pr_author_id, pr_author_login, merged_by_id, merged_by_login, merged_at,
            repo_created_at, recomputed_evidence_hash, onchain_evidence_hash,
            onchain_submission_nonce, github_meta)
     VALUES ($1, $2, '[]', 'v1', 'test', $3, 'a/b', $10, $4, $4, $5, 'dev', $6, 'maintainer',
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
      prNumber,
    ],
  );
  return result.rows[0]?.id ?? '';
}

function insertAttestation(db: Database, f: Fixture, resultId: string, hash = HASH) {
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
    expect(applied.rows.map((row) => row.name)).toEqual([
      '1760000000000_initial-schema',
      '1760100000000_evidence-correction',
      '1760200000000_transactions-per-task',
      '1760300000000_verified-result-matches-registration',
      '1760400000000_settlement-amounts-add-up',
      '1760500000000_settlement-attested',
    ]);
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
      await runner({ ...options, direction: 'down', count: 6 });
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
    await expect(api.query(`UPDATE submissions SET evidence_hash = $1`, [HASH])).rejects.toThrow(
      DENIED,
    );
    await expect(api.query(`DELETE FROM submissions`)).rejects.toThrow(DENIED);
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
      // The only kind of login the API accepts on a deployment.
      await assertConfinedDatabaseLogin(restricted);
      const client = await restricted.connect();
      try {
        await expect(client.query('SET ROLE taskra_attester')).rejects.toThrow(DENIED);
        // Not RESET ROLE: that returns to the role the connection started with.
        await client.query('SET ROLE NONE');
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

// Role names separate nothing by themselves: a connection that has dropped to
// taskra_api can leave it again. What matters is what its login may become.
describe('a login that can leave the API role', () => {
  it('forges a VERIFIED result and an attestation record through the shared login', async () => {
    const f = await fixture();
    const client = await api.connect();
    try {
      await expect(insertResult(client, f.submissionId, 'VERIFIED')).rejects.toThrow(DENIED);
      await client.query('SET ROLE NONE');
      const resultId = await insertResult(client, f.submissionId, 'VERIFIED');
      await insertAttestation(client, f, resultId);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
    const forged = await owner.query(`SELECT 1 FROM attestations WHERE submission_id = $1`, [
      f.submissionId,
    ]);
    expect(forged.rowCount).toBe(1);
  });

  it('is refused by the API at startup: the migration login', async () => {
    await expect(assertConfinedDatabaseLogin(api)).rejects.toThrow(
      /superuser|owns tables of the schema/,
    );
  });

  it('is refused by the API at startup: a login that is a member of both roles', async () => {
    const login = `both_login_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    await owner.query(
      `CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE taskra_api, taskra_attester`,
    );
    const url = new URL(database.url);
    url.username = login;
    url.password = password;
    const shared = createPool(url.toString(), 'taskra_api');
    try {
      await expect(assertConfinedDatabaseLogin(shared)).rejects.toThrow(
        /member of taskra_attester/,
      );
    } finally {
      await shared.end();
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

describe('correcting a registered submission', () => {
  it('lets the API role change only the pull-request number, and only before verification', async () => {
    const f = await fixture();
    const corrected = await api.query(`UPDATE submissions SET pr_number = 7 WHERE id = $1`, [
      f.submissionId,
    ]);
    expect(corrected.rowCount).toBe(1);

    await insertResult(attester, f.submissionId, 'VERIFIED', HASH, 7);
    await expect(
      api.query(`UPDATE submissions SET pr_number = 8 WHERE id = $1`, [f.submissionId]),
    ).rejects.toThrow(/verified submission cannot be pointed at another pull request/);
  });

  it('refuses any other change to a submission, even from the owner', async () => {
    const f = await fixture();
    await expect(
      owner.query(`UPDATE submissions SET evidence_hash = $2 WHERE id = $1`, [
        f.submissionId,
        'ef'.repeat(32),
      ]),
    ).rejects.toThrow(/only the pull-request number/);
    await expect(
      owner.query(`UPDATE submissions SET submission_nonce = 9 WHERE id = $1`, [f.submissionId]),
    ).rejects.toThrow(/only the pull-request number/);
  });
});

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

  it('allow one settlement per task, and only for a transaction recorded for that task', async () => {
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
    // The transaction is not on record for the second task.
    await expect(settle(second.taskId, sig)).rejects.toThrow(/settlements_transaction_fkey/);
  });

  it('let one transaction settle two tasks, each from its own record of it', async () => {
    const first = await fixture();
    const second = await fixture();
    const sig = signature();
    for (const f of [first, second]) {
      await api.query(
        `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot)
         VALUES ($1, $2, 'cancel_task', 'FINALIZED', 1)`,
        [sig, f.taskId],
      );
      await api.query(
        `INSERT INTO settlements (task_id, signature, state, outcome, client_wallet, amount,
                fee_amount, developer_amount, client_amount, disputed, closed_at, slot)
         VALUES ($1, $2, 'CANCELLED', 'CANCELLED', $3, 100, 0, 0, 100, false, now(), 1)`,
        [f.taskId, sig, WALLET],
      );
    }
    const recorded = await owner.query(`SELECT 1 FROM settlements WHERE signature = $1`, [sig]);
    expect(recorded.rowCount).toBe(2);
    // Still one record of a transaction per task.
    await expect(
      api.query(
        `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot)
         VALUES ($1, $2, 'cancel_task', 'FINALIZED', 1)`,
        [sig, first.taskId],
      ),
    ).rejects.toThrow(/onchain_transactions_pkey/);
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

  // N-3: a record divides the task's own amount. Anything swept along with it
  // (a deposit into the escrow) has no column to go into.
  it('refuse a settlement whose amounts do not add up to the task amount', async () => {
    const f = await fixture();
    const sig = signature();
    await api.query(
      `INSERT INTO onchain_transactions (signature, task_id, instruction, status, slot)
       VALUES ($1, $2, 'approve_task', 'FINALIZED', 1)`,
      [sig, f.taskId],
    );
    const settle = (state: string, fee: number, developer: number, client: number) =>
      api.query(
        `INSERT INTO settlements (task_id, signature, state, outcome, client_wallet,
                developer_wallet, amount, fee_amount, developer_amount, client_amount, disputed,
                closed_at, slot)
         VALUES ($1, $2, $3, 'X', $4, $5, 100, $6, $7, $8, false, now(), 1)`,
        [f.taskId, sig, state, WALLET, OTHER_WALLET, fee, developer, client],
      );
    const REFUSED = /settlements_amounts_add_up/;
    // More than the task was worth: the developer's own deposit coming back.
    await expect(settle('SETTLED', 3, 1_000_097, 0)).rejects.toThrow(REFUSED);
    await expect(settle('SETTLED', 3, 96, 0)).rejects.toThrow(REFUSED);
    await expect(settle('SETTLED', 3, 97, 1)).rejects.toThrow(REFUSED);
    await expect(settle('REFUNDED', 0, 0, 1_000_100)).rejects.toThrow(REFUSED);
    await expect(settle('CANCELLED', 0, 0, 99)).rejects.toThrow(REFUSED);
    await settle('SETTLED', 3, 97, 0);
  });
});

// N-2 of the second review. The attestation service records VERIFIED for the
// number it read earlier; the API may correct the number until then. Whichever
// commits first, the other must fail, and the three records must agree.
describe('a VERIFIED result and a correction of the registration', () => {
  async function waitingForALock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting.rowCount !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no statement started waiting for a lock');
  }

  async function records(f: Fixture) {
    const result = await owner.query<{
      registered: string;
      verified: string[] | null;
      attested: string[] | null;
    }>(
      `SELECT s.pr_number AS registered,
              (SELECT array_agg(r.pr_number::text) FROM verification_results r
                WHERE r.submission_id = s.id AND r.status = 'VERIFIED') AS verified,
              (SELECT array_agg(r.pr_number::text) FROM attestations a
                 JOIN verification_results r ON r.id = a.verification_result_id
                WHERE a.submission_id = s.id) AS attested
         FROM submissions s WHERE s.id = $1`,
      [f.submissionId],
    );
    return result.rows[0];
  }

  const correct = (db: Database, f: Fixture, prNumber: number) =>
    db.query(`UPDATE submissions SET pr_number = $2 WHERE id = $1`, [f.submissionId, prNumber]);

  it('refuses a VERIFIED result for a number that is not the registered one', async () => {
    const f = await fixture();
    await expect(insertResult(attester, f.submissionId, 'VERIFIED', HASH, 43)).rejects.toThrow(
      /registered pull request changed/,
    );
    // Results that verify nothing may be about any number: they are history.
    await insertResult(attester, f.submissionId, 'REJECTED', HASH, 43);
    await insertResult(attester, f.submissionId, 'VERIFIED', HASH, 42);
    expect(await records(f)).toEqual({ registered: '42', verified: ['42'], attested: null });
  });

  it('VERIFIED first: the correction waits, then is refused', async () => {
    const f = await fixture();
    const service = await attester.connect();
    let correction: Promise<string>;
    try {
      await service.query('BEGIN');
      const resultId = await insertResult(service, f.submissionId, 'VERIFIED');
      correction = correct(api, f, 43).then(
        () => 'changed',
        (error: unknown) => (error instanceof Error ? error.message : 'unknown error'),
      );
      await waitingForALock();
      await insertAttestation(service, f, resultId);
      await service.query('COMMIT');
    } finally {
      service.release();
    }
    expect(await correction).toMatch(/cannot be pointed at another pull request/);
    expect(await records(f)).toEqual({ registered: '42', verified: ['42'], attested: ['42'] });
  });

  it('correction first: the VERIFIED result waits, then is refused, and nothing is locked in', async () => {
    const f = await fixture();
    const request = await api.connect();
    let verified: Promise<string>;
    try {
      await request.query('BEGIN');
      await correct(request, f, 43);
      verified = insertResult(attester, f.submissionId, 'VERIFIED').then(
        () => 'recorded',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'unknown error',
      );
      await waitingForALock();
      await request.query('COMMIT');
    } finally {
      request.release();
    }
    // serialization_failure: the attestation service retries from what is registered now.
    expect(await verified).toBe('40001');
    expect(await records(f)).toEqual({ registered: '43', verified: null, attested: null });

    // Recoverable in both directions: correct it back, or verify the new number.
    await correct(api, f, 42);
    await correct(api, f, 43);
    const resultId = await insertResult(attester, f.submissionId, 'VERIFIED', HASH, 43);
    await insertAttestation(attester, f, resultId);
    expect(await records(f)).toEqual({ registered: '43', verified: ['43'], attested: ['43'] });
    await expect(correct(api, f, 42)).rejects.toThrow(/cannot be pointed at another/);
  });

  // A row lock alone would not do: once released it leaves no trace, and a
  // transaction that took its snapshot earlier would not see the VERIFIED
  // result either. The API never uses this isolation level; someone holding
  // its database role could.
  it('VERIFIED first, correction on a snapshot taken before it: still refused', async () => {
    const f = await fixture();
    const request = await api.connect();
    let outcome: unknown;
    try {
      await request.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await request.query(`SELECT pr_number FROM submissions WHERE id = $1`, [f.submissionId]);
      const resultId = await insertResult(attester, f.submissionId, 'VERIFIED');
      await insertAttestation(attester, f, resultId);
      outcome = await correct(request, f, 43).then(
        () => 'changed',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'unknown error',
      );
      await request.query(outcome === 'changed' ? 'COMMIT' : 'ROLLBACK');
    } finally {
      request.release();
    }
    expect(outcome).toBe('40001');
    expect(await records(f)).toEqual({ registered: '42', verified: ['42'], attested: ['42'] });
  });

  it('gives the attester role no way to lock or change a submission itself', async () => {
    const f = await fixture();
    await expect(
      attester.query(`SELECT 1 FROM submissions WHERE id = $1 FOR SHARE`, [f.submissionId]),
    ).rejects.toThrow(DENIED);
    await expect(correct(attester, f, 43)).rejects.toThrow(DENIED);
  });
});
