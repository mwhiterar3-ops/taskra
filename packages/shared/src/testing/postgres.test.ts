// The test database must never change how a test run ends. An earlier version
// of this harness used a launcher whose exit hook ended the process with code
// 0, so a failing suite was reported as passing. This test runs the harness in
// a child process that fails on purpose and checks that the failure survives.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const HARNESS = new URL('../../dist/testing/postgres.js', import.meta.url).href;

function runChild(script: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('test PostgreSQL harness', { timeout: 150_000 }, () => {
  it('starts a server, runs a query, and stops cleanly with exit code 0', () => {
    const result = runChild(`
      import pg from 'pg';
      import { startTestPostgres } from '${HARNESS}';
      const server = await startTestPostgres();
      const client = new pg.Client({ connectionString: server.adminUrl });
      await client.connect();
      const version = await client.query('SHOW server_version');
      await client.end();
      await server.stop();
      console.log('version ' + version.rows[0].server_version);
    `);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^version 17\./);
    expect(result.status).toBe(0);
  });

  it('does not turn a failing process into a passing one', () => {
    const result = runChild(`
      import { startTestPostgres } from '${HARNESS}';
      const server = await startTestPostgres();
      process.exitCode = 3; // what a test runner does when a test fails
      await server.stop();
    `);
    expect(result.status).toBe(3);
  });

  it('does not outlive a process that exits without stopping it', () => {
    const result = runChild(`
      import { startTestPostgres } from '${HARNESS}';
      const server = await startTestPostgres();
      console.log(new URL(server.adminUrl).port);
      process.exit(7);
    `);
    expect(result.status).toBe(7);
    const port = result.stdout.trim();
    const listening = spawnSync('sh', ['-c', `ss -ltn 2>/dev/null | grep -c ":${port} " || true`], {
      encoding: 'utf8',
    });
    expect(listening.stdout.trim()).toBe('0');
  });
});
