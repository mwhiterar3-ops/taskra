// The API's check of its own database login, tested where it matters: the real
// process, started from `main.ts` the way a deployment starts it, against
// PostgreSQL with real logins. A unit test of the query alone would not show
// that anything refuses to listen.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPool } from '@taskra/shared/db';
import { type TestDatabase, testDatabase } from '@taskra/shared/testing/postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDeployed } from './config.js';
import { assertConfinedDatabaseLogin } from './startup.js';

const API_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

let database: TestDatabase;
let owner: pg.Pool;
const logins: string[] = [];

beforeAll(async () => {
  database = await testDatabase();
  owner = new pg.Pool({ connectionString: database.url, max: 2 });
});
afterAll(async () => {
  for (const name of logins) {
    await owner.query(`REASSIGN OWNED BY ${name} TO CURRENT_USER`);
    await owner.query(`DROP OWNED BY ${name}`);
    await owner.query(`DROP ROLE ${name}`);
  }
  await owner.end();
  await database.drop();
});

/** Creates a login and returns the connection string for it. */
async function login(clause: string, grant?: (name: string) => string): Promise<string> {
  const name = `startup_${randomBytes(5).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await owner.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${clause}`);
  logins.push(name);
  if (grant !== undefined) await owner.query(grant(name));
  const url = new URL(database.url);
  url.username = name;
  url.password = password;
  return url.toString();
}

/** The login a deployment is meant to use. */
const confined = () => login('IN ROLE taskra_api');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

interface Outcome {
  /** Whether the process ever answered a request. */
  readonly served: boolean;
  /** Exit code, when it stopped by itself. */
  readonly exitCode: number | null;
  readonly output: string;
}

const DEPLOYED = { NODE_ENV: 'production', WEB_ORIGIN: 'https://app.taskra.example' };
const LOCAL = { NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:3000' };

/** Starts the API as its own process and reports whether it came to serve. */
async function startApi(databaseUrl: string, overrides: Record<string, string>): Promise<Outcome> {
  const port = await freePort();
  let output = '';
  let exited: number | null | undefined;
  // A minimal environment: nothing leaks in from the shell that runs the suite.
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: API_DIRECTORY,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      SOLANA_NETWORK: 'localnet',
      SOLANA_RPC_URL: 'http://127.0.0.1:8899',
      TASKRA_PROGRAM_ID: '11111111111111111111111111111111',
      USDC_MINT: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      DATABASE_URL: databaseUrl,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const stopped = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exited = code;
      resolve();
    });
  });

  let served = false;
  for (let attempt = 0; attempt < 200 && exited === undefined && !served; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      served = response.status === 200;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (exited === undefined) {
    child.kill('SIGTERM');
    await stopped;
  }
  return { served, exitCode: served ? null : (exited ?? null), output };
}

function expectRefused(outcome: Outcome, reason: RegExp): void {
  expect(outcome.output).toMatch(/refusing to start/);
  expect(outcome.output).toMatch(reason);
  expect(outcome.served).toBe(false);
  expect(outcome.exitCode).toBe(1);
}

describe('the API process on a deployment', () => {
  it('refuses to start with a superuser login', async () => {
    // The login the test database was created with.
    expectRefused(await startApi(database.url, DEPLOYED), /is a superuser/);
  });

  it('refuses to start with a login that owns a table of the schema', async () => {
    const url = await login(
      'IN ROLE taskra_api',
      (name) => `ALTER TABLE verification_results OWNER TO ${name}`,
    );
    const outcome = await startApi(url, DEPLOYED);
    expectRefused(outcome, /owns tables of the schema/);
    expect(outcome.output).not.toMatch(/superuser/);
  });

  it('refuses to start with a login that can assume taskra_attester', async () => {
    const outcome = await startApi(await login('IN ROLE taskra_api, taskra_attester'), DEPLOYED);
    expectRefused(outcome, /is a member of taskra_attester/);
    expect(outcome.output).not.toMatch(/superuser|owns tables/);
  });

  it('refuses to start when the login cannot be inspected at all', async () => {
    const unreachable = new URL(database.url);
    unreachable.port = String(await freePort());
    const outcome = await startApi(unreachable.toString(), DEPLOYED);
    expect(outcome.output).toMatch(/refusing to start/);
    expect(outcome.served).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it('starts and serves with a login that is a member of taskra_api only', async () => {
    const outcome = await startApi(await confined(), DEPLOYED);
    expect(outcome.output).not.toMatch(/refusing to start/);
    expect(outcome.served).toBe(true);
  });
});

// The check is skipped on a developer's own machine and nowhere else. Each of
// the three signs of a deployment must be enough by itself.
describe('what counts as a deployment', () => {
  it('a production NODE_ENV, even with a loopback web origin', async () => {
    const outcome = await startApi(database.url, { ...LOCAL, NODE_ENV: 'production' });
    expectRefused(outcome, /is a superuser/);
  });

  it('a web origin that is not this machine, whatever NODE_ENV says', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const outcome = await startApi(database.url, { ...DEPLOYED, NODE_ENV });
      expectRefused(outcome, /is a superuser/);
    }
  });

  it('an interface other machines can reach, even in development with a loopback origin', async () => {
    const outcome = await startApi(database.url, { ...LOCAL, API_HOST: '0.0.0.0' });
    expectRefused(outcome, /is a superuser/);
  });

  it('not a development process on loopback: there one login serves everything', async () => {
    const outcome = await startApi(database.url, LOCAL);
    expect(outcome.output).not.toMatch(/refusing to start/);
    expect(outcome.served).toBe(true);
  });

  it('is decided by the configuration alone', () => {
    const local = { NODE_ENV: 'development', API_HOST: '127.0.0.1' } as const;
    for (const WEB_ORIGIN of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]) {
      expect(isDeployed({ ...local, WEB_ORIGIN }), WEB_ORIGIN).toBe(false);
      expect(isDeployed({ ...local, WEB_ORIGIN, NODE_ENV: 'test' }), WEB_ORIGIN).toBe(false);
      expect(isDeployed({ ...local, WEB_ORIGIN, API_HOST: 'localhost' }), WEB_ORIGIN).toBe(false);
      expect(isDeployed({ ...local, WEB_ORIGIN, API_HOST: '::1' }), WEB_ORIGIN).toBe(false);
      expect(isDeployed({ ...local, WEB_ORIGIN, NODE_ENV: 'production' }), WEB_ORIGIN).toBe(true);
      for (const API_HOST of ['0.0.0.0', '::', '192.168.1.10', 'api.taskra.example']) {
        expect(isDeployed({ ...local, WEB_ORIGIN, API_HOST }), API_HOST).toBe(true);
      }
    }
    // Names that only look local.
    for (const WEB_ORIGIN of [
      'https://app.taskra.example',
      'https://localhost.taskra.example',
      'http://127.0.0.1.nip.io:3000',
      'http://192.168.1.10:3000',
      'http://0.0.0.0:3000',
    ]) {
      expect(isDeployed({ ...local, WEB_ORIGIN }), WEB_ORIGIN).toBe(true);
    }
  });
});

// The same check, without a process, for the logins that are awkward to give
// a whole process: what decides is what the login could write, not its name.
describe('the check itself', () => {
  async function inspect(url: string): Promise<string> {
    const pool = createPool(url, 'taskra_api');
    try {
      await assertConfinedDatabaseLogin(pool);
      return 'accepted';
    } catch (error) {
      return error instanceof Error ? error.message : 'unknown error';
    } finally {
      await pool.end();
    }
  }

  it('accepts a member of taskra_api only', async () => {
    expect(await inspect(await confined())).toBe('accepted');
  });

  it('refuses a login that may create and alter roles', async () => {
    expect(await inspect(await login('CREATEROLE IN ROLE taskra_api'))).toMatch(
      /can create and alter roles/,
    );
  });

  it('refuses a login granted the privilege directly, with no telling role', async () => {
    const direct = await login(
      'IN ROLE taskra_api',
      (name) => `GRANT INSERT ON verification_results TO ${name}`,
    );
    expect(await inspect(direct)).toMatch(/can write verification results or attestation records/);
    const update = await login(
      'IN ROLE taskra_api',
      (name) => `GRANT UPDATE ON attestations TO ${name}`,
    );
    expect(await inspect(update)).toMatch(/can write verification results or attestation records/);
  });

  it('refuses a login that can write every table through a predefined role', async () => {
    expect(await inspect(await login('IN ROLE taskra_api, pg_write_all_data'))).toMatch(
      /can write verification results or attestation records/,
    );
  });

  it('refuses a login that reaches the attester role through another role', async () => {
    const group = `startup_group_${randomBytes(4).toString('hex')}`;
    await owner.query(`CREATE ROLE ${group} NOLOGIN IN ROLE taskra_attester`);
    logins.push(group);
    expect(await inspect(await login(`IN ROLE taskra_api, ${group}`))).toMatch(
      /is a member of taskra_attester/,
    );
  });
});
