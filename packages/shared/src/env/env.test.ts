import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EnvValidationError } from './common.js';
import { loadPublicEnv, publicEnvSchema } from './public.js';
import { loadServerEnv, serverEnvSchema } from './server.js';

// Well-known, non-confidential addresses used purely as syntactically valid fixtures.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const validPublic = {
  NEXT_PUBLIC_SOLANA_NETWORK: 'devnet',
  NEXT_PUBLIC_SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  NEXT_PUBLIC_TASKRA_PROGRAM_ID: SYSTEM_PROGRAM,
  NEXT_PUBLIC_USDC_MINT: TOKEN_PROGRAM,
  NEXT_PUBLIC_API_URL: 'http://localhost:4000',
};

const validServer = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3000',
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  TASKRA_PROGRAM_ID: SYSTEM_PROGRAM,
  USDC_MINT: TOKEN_PROGRAM,
  DATABASE_URL: 'postgres://taskra:fixture-password@localhost:5432/taskra',
  GITHUB_CLIENT_ID: 'fixture-client-id',
  GITHUB_CLIENT_SECRET: 'fixture-client-secret',
};

function captureError(run: () => unknown): EnvValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected EnvValidationError');
}

describe('valid environments', () => {
  it('parses a complete server environment and coerces the port', () => {
    const env = loadServerEnv(validServer);
    expect(env.API_PORT).toBe(4000);
    expect(env.SOLANA_NETWORK).toBe('devnet');
  });

  it('parses a complete public environment', () => {
    expect(loadPublicEnv(validPublic)).toEqual(validPublic);
  });
});

describe('missing required values', () => {
  it.each(Object.keys(validServer))('rejects a server environment without %s', (key) => {
    const error = captureError(() => loadServerEnv({ ...validServer, [key]: undefined }));
    expect(error.issues).toEqual([{ variable: key, message: 'is required' }]);
  });

  it.each(Object.keys(validPublic))('rejects a public environment without %s', (key) => {
    const error = captureError(() => loadPublicEnv({ ...validPublic, [key]: undefined }));
    expect(error.issues).toEqual([{ variable: key, message: 'is required' }]);
  });

  it('treats an empty string as missing', () => {
    const error = captureError(() => loadServerEnv({ ...validServer, USDC_MINT: '' }));
    expect(error.issues).toEqual([{ variable: 'USDC_MINT', message: 'is required' }]);
  });

  it('reports every missing variable at once', () => {
    const error = captureError(() => loadServerEnv({}));
    expect(error.issues.map((issue) => issue.variable).sort()).toEqual(
      Object.keys(validServer).sort(),
    );
  });
});

describe('invalid values', () => {
  it.each([
    ['NODE_ENV', 'staging'],
    ['API_PORT', '0'],
    ['API_PORT', '70000'],
    ['API_PORT', '40.5'],
    ['API_PORT', 'abc'],
    ['WEB_ORIGIN', 'not-a-url'],
    ['SOLANA_NETWORK', 'testnet'],
    ['SOLANA_RPC_URL', 'ftp://example.com'],
    ['TASKRA_PROGRAM_ID', 'not-base58-0OIl'],
    ['TASKRA_PROGRAM_ID', 'abc'],
    ['USDC_MINT', `${TOKEN_PROGRAM}1`],
    ['DATABASE_URL', 'https://localhost:5432/taskra'],
  ])('rejects server %s=%s', (key, value) => {
    const error = captureError(() => loadServerEnv({ ...validServer, [key]: value }));
    expect(error.issues.map((issue) => issue.variable)).toEqual([key]);
  });

  it.each([
    ['NEXT_PUBLIC_SOLANA_NETWORK', 'testnet'],
    ['NEXT_PUBLIC_SOLANA_RPC_URL', 'ws://example.com'],
    ['NEXT_PUBLIC_TASKRA_PROGRAM_ID', 'abc'],
    ['NEXT_PUBLIC_USDC_MINT', ''.padEnd(44, '0')],
    ['NEXT_PUBLIC_API_URL', 'localhost:4000'],
  ])('rejects public %s=%s', (key, value) => {
    const error = captureError(() => loadPublicEnv({ ...validPublic, [key]: value }));
    expect(error.issues.map((issue) => issue.variable)).toEqual([key]);
  });

  it('never echoes a rejected value in the error message', () => {
    const secret = 'https://user:super-secret-password@db.example.com/taskra';
    const error = captureError(() => loadServerEnv({ ...validServer, DATABASE_URL: secret }));
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('super-secret-password');
  });
});

describe('public/server separation', () => {
  const publicKeys = Object.keys(publicEnvSchema.shape);
  const serverKeys = Object.keys(serverEnvSchema.shape);

  it('names every public variable NEXT_PUBLIC_* and no server variable so', () => {
    expect(publicKeys.every((key) => key.startsWith('NEXT_PUBLIC_'))).toBe(true);
    expect(serverKeys.some((key) => key.startsWith('NEXT_PUBLIC_'))).toBe(false);
  });

  it('shares no variable between the two schemas', () => {
    expect(publicKeys.filter((key) => serverKeys.includes(key))).toEqual([]);
  });

  it('drops server variables from the public environment even when they are present', () => {
    const env = loadPublicEnv({ ...validServer, ...validPublic });
    expect(Object.keys(env).sort()).toEqual([...publicKeys].sort());
  });

  it('drops public variables from the server environment', () => {
    const env = loadServerEnv({ ...validServer, ...validPublic });
    expect(Object.keys(env).sort()).toEqual([...serverKeys].sort());
  });
});

describe('.env.example', () => {
  type Label = 'PUBLIC' | 'SERVER_ONLY' | 'SECRET';

  const entries = new Map<string, { label: Label | undefined; value: string }>();
  let previousLine = '';
  const file = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  for (const line of file.split(/\r?\n/)) {
    const assignment = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (assignment?.[1] !== undefined && assignment[2] !== undefined) {
      const label = /^# \[(PUBLIC|SERVER_ONLY|SECRET)\]/.exec(previousLine)?.[1] as
        Label | undefined;
      entries.set(assignment[1], { label, value: assignment[2] });
    }
    previousLine = line;
  }

  it('labels every variable PUBLIC, SERVER_ONLY or SECRET', () => {
    const unlabelled = [...entries].filter(([, entry]) => entry.label === undefined);
    expect(unlabelled.map(([name]) => name)).toEqual([]);
  });

  it('documents every variable in both schemas', () => {
    const schemaKeys = [
      ...Object.keys(publicEnvSchema.shape),
      ...Object.keys(serverEnvSchema.shape),
    ];
    expect(schemaKeys.filter((key) => !entries.has(key))).toEqual([]);
  });

  it('labels a variable PUBLIC exactly when it is NEXT_PUBLIC_*', () => {
    for (const [name, entry] of entries) {
      expect(entry.label === 'PUBLIC', name).toBe(name.startsWith('NEXT_PUBLIC_'));
    }
  });

  it('ships no value for any SECRET variable', () => {
    const filled = [...entries].filter(([, entry]) => entry.label === 'SECRET' && entry.value);
    expect(filled.map(([name]) => name)).toEqual([]);
  });
});
