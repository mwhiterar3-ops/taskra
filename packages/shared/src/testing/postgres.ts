// Throwaway PostgreSQL for tests. Never used by a running service.
//
// By default this starts an ephemeral PostgreSQL from the `embedded-postgres`
// binaries in a temporary directory, so the suites need neither Docker nor a
// system installation. Set TASKRA_TEST_DATABASE_URL to an admin connection
// string (for example the docker-compose server) to use that server instead;
// only uniquely named databases are created on it, and they are dropped again.

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

export interface TestPostgres {
  /** Connection string of a login that may create databases and roles. */
  readonly adminUrl: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
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

export async function startTestPostgres(): Promise<TestPostgres> {
  const external = process.env['TASKRA_TEST_DATABASE_URL'];
  if (external !== undefined && external !== '') {
    return { adminUrl: external, stop: () => Promise.resolve() };
  }

  const databaseDir = await mkdtemp(join(tmpdir(), 'taskra-test-pg-'));
  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  return {
    adminUrl: `postgres://postgres:${password}@127.0.0.1:${String(port)}/postgres`,
    stop: async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function admin(adminUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Creates a database, applies every migration in `migrationsDir`, and returns its name. */
export async function createMigratedTemplate(
  adminUrl: string,
  migrationsDir: string,
): Promise<string> {
  const name = uniqueName('taskra_tpl');
  await admin(adminUrl, `CREATE DATABASE "${name}"`);
  await migrate(withDatabase(adminUrl, name), migrationsDir);
  return name;
}

export async function migrate(databaseUrl: string, migrationsDir: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
}

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/** A fresh copy of `template`. Every test file gets its own. */
export async function createTestDatabase(
  adminUrl: string,
  template: string,
): Promise<TestDatabase> {
  const name = uniqueName('taskra_test');
  await admin(adminUrl, `CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  return {
    url: withDatabase(adminUrl, name),
    drop: () => admin(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await admin(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

// Names shared between a Vitest globalSetup and the test files it serves.
export const TEST_ADMIN_URL_ENV = 'TASKRA_TEST_ADMIN_URL';
export const TEST_TEMPLATE_ENV = 'TASKRA_TEST_TEMPLATE';

/** For a Vitest `globalSetup`: starts PostgreSQL, migrates a template, returns the teardown. */
export async function setupTestPostgres(migrationsDir: string): Promise<() => Promise<void>> {
  const server = await startTestPostgres();
  const template = await createMigratedTemplate(server.adminUrl, migrationsDir);
  process.env[TEST_ADMIN_URL_ENV] = server.adminUrl;
  process.env[TEST_TEMPLATE_ENV] = template;
  return async () => {
    await dropDatabase(server.adminUrl, template);
    await server.stop();
  };
}

/** For a test file: a fresh database from the template the globalSetup prepared. */
export async function testDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env[TEST_ADMIN_URL_ENV];
  const template = process.env[TEST_TEMPLATE_ENV];
  if (adminUrl === undefined || template === undefined) {
    throw new Error('the test PostgreSQL was not started: is the Vitest globalSetup configured?');
  }
  return createTestDatabase(adminUrl, template);
}
