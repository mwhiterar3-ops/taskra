// Throwaway PostgreSQL for tests. Never used by a running service.
//
// By default this starts an ephemeral PostgreSQL from the `embedded-postgres`
// binaries in a temporary directory, so the suites need neither Docker nor a
// system installation. Set TASKRA_TEST_DATABASE_URL to an admin connection
// string (for example the docker-compose server) to use that server instead;
// only uniquely named databases are created on it, and they are dropped again.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  const binaries = await postgresBinaries();
  const databaseDir = await mkdtemp(join(tmpdir(), 'taskra-test-pg-'));
  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const passwordFile = join(databaseDir, '..', `${basename(databaseDir)}.pwfile`);
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  try {
    await run(binaries.initdb, [
      `--pgdata=${databaseDir}`,
      '--auth=password',
      '--username=postgres',
      `--pwfile=${passwordFile}`,
    ]);
  } finally {
    await rm(passwordFile, { force: true });
  }

  const server = spawn(
    binaries.postgres,
    ['-D', databaseDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-k', databaseDir],
    { stdio: 'ignore' },
  );
  // If this process dies without stopping the server, take the server with it.
  // A plain synchronous kill: it never changes this process's exit code.
  const killOnExit = () => server.kill('SIGKILL');
  process.once('exit', killOnExit);

  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${String(port)}/postgres`;
  await waitUntilReady(adminUrl, server);
  return {
    adminUrl,
    stop: async () => {
      process.off('exit', killOnExit);
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill('SIGINT'); // fast shutdown
      await exited;
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

interface PostgresBinaries {
  readonly postgres: string;
  readonly initdb: string;
}

/**
 * Paths of the PostgreSQL binaries shipped by the `embedded-postgres` package.
 *
 * Only the binaries are used. The package's own JavaScript launcher is never
 * imported: it installs an exit hook that ends the process with code 0, which
 * would make a failing test run look like a passing one.
 */
async function postgresBinaries(): Promise<PostgresBinaries> {
  const fromShared = createRequire(import.meta.url);
  const fromLauncher = createRequire(fromShared.resolve('embedded-postgres'));
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const entry = fromLauncher.resolve(`@embedded-postgres/${platform}-${process.arch}`);
  const binaries = (await import(pathToFileURL(entry).href)) as PostgresBinaries;
  await Promise.all([chmod(binaries.postgres, 0o755), chmod(binaries.initdb, 0o755)]);
  return binaries;
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${basename(command)} exited with code ${String(code)}: ${errors}`));
    });
  });
}

async function waitUntilReady(adminUrl: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error('the test PostgreSQL exited during startup');
    const client = new pg.Client({ connectionString: adminUrl });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
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
