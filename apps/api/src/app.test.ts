import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discardForeignSecrets, loadApiConfig, servedOverHttps } from './config.js';
import { createHarness, createWallet, type Harness, WEB_ORIGIN } from './testing/harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

describe('health and readiness', () => {
  it('answers GET /health without touching any dependency', async () => {
    harness.chain.available = false;
    const response = await harness.get('/health');
    harness.chain.available = true;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database and the RPC endpoint answer', async () => {
    const response = await harness.get('/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'ok', rpc: 'ok' } });
  });

  it('reports not ready, and only which dependency failed, when the RPC endpoint is down', async () => {
    harness.chain.available = false;
    const response = await harness.get('/ready');
    harness.chain.available = true;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'ok', rpc: 'unavailable' },
    });
    expect(response.body).not.toMatch(/127\.0\.0\.1|postgres|password/i);
  });
});

describe('error responses', () => {
  it('uses one shape for unknown routes', async () => {
    const response = await harness.get('/api/tasks');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  it('reports validation failures by field, without echoing a stack', async () => {
    const response = await harness.post('/api/v1/auth/challenge', { wallet: 'not-an-address' });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; details: { path: string }[] } }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((issue) => issue.path)).toEqual(['wallet']);
    expect(response.body).not.toMatch(/at .*\.ts|node_modules/);
  });

  it('rejects malformed JSON as a client error', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/challenge',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
      payload: '{"wallet": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });

  it('hides the cause of an unexpected failure', async () => {
    const cookie = await harness.signIn(createWallet());
    await harness.admin.query('ALTER TABLE tasks RENAME TO tasks_hidden');
    const response = await harness.get('/api/v1/tasks', cookie);
    await harness.admin.query('ALTER TABLE tasks_hidden RENAME TO tasks');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error.' } });
  });

  it('sets no-store and nosniff on every response', async () => {
    const response = await harness.get('/health');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS', () => {
  it('allows credentialed requests from the web origin only', async () => {
    const allowed = await harness.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/tasks',
      headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const other = await harness.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/tasks',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

describe('rate limiting', () => {
  it('limits sign-in attempts per client', async () => {
    const limited = await createHarness({ rateLimit: true });
    try {
      const wallet = createWallet().address;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 22; attempt += 1) {
        const response = await limited.post('/api/v1/auth/challenge', { wallet });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
      const blocked = await limited.post('/api/v1/auth/challenge', { wallet });
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});

describe('API config', () => {
  const env = {
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    WEB_ORIGIN,
    SOLANA_NETWORK: 'localnet',
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    TASKRA_PROGRAM_ID: '11111111111111111111111111111111',
    USDC_MINT: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    DATABASE_URL: 'postgres://taskra:fixture@localhost:5432/taskra',
  };

  it('loads without a GitHub OAuth app and coerces the port', () => {
    const config = loadApiConfig(env);
    expect(config.API_PORT).toBe(4000);
    expect(config.GITHUB_CLIENT_ID).toBeUndefined();
  });

  it('refuses to start without a port', () => {
    expect(() => loadApiConfig({ ...env, API_PORT: undefined })).toThrow(/API_PORT: is required/);
  });

  it('refuses to start in production when the attester key is in its environment', () => {
    const key = JSON.stringify(Array.from({ length: 64 }, () => 1));
    expect(() =>
      loadApiConfig({ ...env, NODE_ENV: 'production', ATTESTER_SECRET_KEY: key }),
    ).toThrow(/ATTESTER_SECRET_KEY: must not be present in the API environment/);
    expect(() => loadApiConfig({ ...env, NODE_ENV: 'production' })).not.toThrow();
  });

  it('refuses the attester key on any deployed origin, whatever NODE_ENV says', () => {
    const key = JSON.stringify(Array.from({ length: 64 }, () => 1));
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(() =>
        loadApiConfig({
          ...env,
          NODE_ENV,
          WEB_ORIGIN: 'https://app.taskra.example',
          ATTESTER_SECRET_KEY: key,
        }),
      ).toThrow(/ATTESTER_SECRET_KEY: must not be present/);
    }
    // On this machine, in development, one .env serves every process.
    expect(() => loadApiConfig({ ...env, ATTESTER_SECRET_KEY: key })).not.toThrow();
  });

  it('refuses a deployed web origin that is not https, whatever NODE_ENV says', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(() =>
        loadApiConfig({ ...env, NODE_ENV, WEB_ORIGIN: 'http://app.taskra.example' }),
      ).toThrow(/WEB_ORIGIN: must use https unless it is a loopback address/);
    }
    expect(() => loadApiConfig({ ...env, WEB_ORIGIN: 'https://app.taskra.example' })).not.toThrow();
    expect(() => loadApiConfig({ ...env, WEB_ORIGIN: 'http://127.0.0.1:3000' })).not.toThrow();
  });

  it('marks cookies Secure exactly when the web origin is https', () => {
    expect(servedOverHttps({ WEB_ORIGIN: 'https://app.taskra.example' })).toBe(true);
    expect(servedOverHttps({ WEB_ORIGIN: 'http://localhost:3000' })).toBe(false);
  });

  it('removes the attester key from the process environment in development', () => {
    const environment: Record<string, string | undefined> = {
      ...env,
      ATTESTER_SECRET_KEY: 'local-test-key',
    };
    discardForeignSecrets(environment);
    expect('ATTESTER_SECRET_KEY' in environment).toBe(false);
    expect(environment['DATABASE_URL']).toBe(env.DATABASE_URL);
  });

  it('never loads the attester key, even when it is present in the environment', () => {
    const config = loadApiConfig({
      ...env,
      ATTESTER_SECRET_KEY: JSON.stringify(Array.from({ length: 64 }, () => 1)),
    });
    expect(Object.keys(config)).not.toContain('ATTESTER_SECRET_KEY');
  });
});

describe('the API never signs', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url));

  function shippedSources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'testing' ? [] : shippedSources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
  }

  // The API verifies signatures (crypto.verify) but must never be able to make one.
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['Keypair', /\bKeypair\b/],
    ['secret key', /secretKey|fromSecretKey|fromSeed\b|privateKey|createPrivateKey/],
    ['attester key', /ATTESTER_SECRET_KEY/],
    [
      'transaction signing or sending',
      /\.sign\(|sendTransaction|sendRawTransaction|sendAndConfirm/,
    ],
    ['instruction builder', /recordAttestation|resolveDispute|rotateKeys/],
  ];

  const files = shippedSources(SRC);

  it('scans the real source tree', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.some((file) => file.endsWith('/chain/reader.ts'))).toBe(true);
  });

  it.each(FORBIDDEN)('no shipped source mentions a %s', (name, pattern) => {
    // config.ts names the attester variable only to explain why it is absent.
    const offenders = files
      .filter((file) => !(name === 'attester key' && file.endsWith('/config.ts')))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
