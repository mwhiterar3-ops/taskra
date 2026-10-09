import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  createWallet,
  DRAFT,
  type Harness,
  type TestWallet,
  WEB_ORIGIN,
} from '../testing/harness.js';
import {
  CHALLENGE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyWalletSignature,
} from './challenge.js';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

interface Challenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

async function challengeFor(wallet: TestWallet): Promise<Challenge> {
  const response = await harness.post('/api/v1/auth/challenge', { wallet: wallet.address });
  expect(response.statusCode).toBe(200);
  return response.json<Challenge>();
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

describe('challenge', () => {
  it('binds the message to the site, the wallet, the cluster and a fresh nonce', async () => {
    const wallet = createWallet();
    const first = await challengeFor(wallet);
    const second = await challengeFor(wallet);

    expect(first.message.split('\n')[0]).toBe(
      'localhost:3000 wants you to sign in with your Solana account:',
    );
    expect(first.message).toContain(`\n${wallet.address}\n`);
    expect(first.message).toContain(`URI: ${WEB_ORIGIN}`);
    expect(first.message).toContain('Chain ID: solana:localnet');
    expect(first.message).toContain(`Nonce: ${first.nonce}`);
    expect(first.message).toContain('not a transaction');
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.nonce).not.toBe(first.nonce);
  });
});

describe('sign-in', () => {
  it('creates a session for a valid signature and sets a hardened cookie', async () => {
    const wallet = createWallet();
    const { nonce, message } = await challengeFor(wallet);
    const response = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: wallet.signMessage(message),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ wallet: string }>().wallet).toBe(wallet.address);

    const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    const token = cookie?.value ?? '';

    // Only a hash of the token is stored.
    const stored = await harness.admin.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE wallet = $1',
      [wallet.address],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).not.toContain(token);

    const session = await harness.get('/api/v1/auth/session', `${SESSION_COOKIE}=${token}`);
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ wallet: wallet.address, github: null });
  });

  it('rejects a signature made by a different key, and spends the nonce', async () => {
    const wallet = createWallet();
    const attacker = createWallet();
    const { nonce, message } = await challengeFor(wallet);

    const forged = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: attacker.signMessage(message),
    });
    expect(forged.statusCode).toBe(401);
    expect(errorCode(forged)).toBe('INVALID_SIGNATURE');
    expect(forged.cookies).toEqual([]);

    // Even the right signature cannot use that nonce any more.
    const late = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: wallet.signMessage(message),
    });
    expect(errorCode(late)).toBe('INVALID_CHALLENGE');
  });

  it('rejects a signature over any text other than the issued message', async () => {
    const wallet = createWallet();
    const { nonce, message } = await challengeFor(wallet);
    const response = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: wallet.signMessage(message.replace('localhost:3000', 'evil.example')),
    });
    expect(errorCode(response)).toBe('INVALID_SIGNATURE');
  });

  it('rejects a replayed nonce', async () => {
    const wallet = createWallet();
    const { nonce, message } = await challengeFor(wallet);
    const body = { nonce, signature: wallet.signMessage(message) };
    expect((await harness.post('/api/v1/auth/verify', body)).statusCode).toBe(200);
    const replay = await harness.post('/api/v1/auth/verify', body);
    expect(replay.statusCode).toBe(401);
    expect(errorCode(replay)).toBe('INVALID_CHALLENGE');
  });

  it('lets exactly one of several concurrent uses of a nonce succeed', async () => {
    const wallet = createWallet();
    const { nonce, message } = await challengeFor(wallet);
    const body = { nonce, signature: wallet.signMessage(message) };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => harness.post('/api/v1/auth/verify', body)),
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(7);
  });

  it('rejects an expired challenge', async () => {
    const wallet = createWallet();
    const { nonce, message } = await challengeFor(wallet);
    harness.advance(CHALLENGE_TTL_SECONDS + 1);
    const response = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: wallet.signMessage(message),
    });
    expect(errorCode(response)).toBe('INVALID_CHALLENGE');
  });

  it('rejects an unknown nonce and unexpected fields', async () => {
    const wallet = createWallet();
    const unknown = await harness.post('/api/v1/auth/verify', {
      nonce: 'A'.repeat(43),
      signature: wallet.signMessage('anything'),
    });
    expect(errorCode(unknown)).toBe('INVALID_CHALLENGE');

    const { nonce, message } = await challengeFor(wallet);
    const extra = await harness.post('/api/v1/auth/verify', {
      nonce,
      signature: wallet.signMessage(message),
      wallet: createWallet().address,
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe('sessions', () => {
  it('expire after their lifetime', async () => {
    const cookie = await harness.signIn(createWallet());
    harness.advance(SESSION_TTL_SECONDS - 5);
    expect((await harness.get('/api/v1/auth/session', cookie)).statusCode).toBe(200);
    harness.advance(10);
    const expired = await harness.get('/api/v1/auth/session', cookie);
    expect(expired.statusCode).toBe(401);
    expect(errorCode(expired)).toBe('UNAUTHENTICATED');
  });

  it('are revoked by logout', async () => {
    const cookie = await harness.signIn(createWallet());
    const logout = await harness.post('/api/v1/auth/logout', {}, cookie);
    expect(logout.statusCode).toBe(200);
    expect((await harness.get('/api/v1/auth/session', cookie)).statusCode).toBe(401);
  });

  it('are not created by a forged or guessed cookie', async () => {
    const guessed = await harness.get(
      '/api/v1/auth/session',
      `${SESSION_COOKIE}=${'B'.repeat(43)}`,
    );
    expect(guessed.statusCode).toBe(401);
  });
});

describe('authorization boundary', () => {
  it('does not treat a wallet address in the request as proof of ownership', async () => {
    const victim = createWallet();
    const response = await harness.post('/api/v1/tasks', {
      ...DRAFT,
      clientWallet: victim.address,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses state-changing requests from another origin, even with a valid session', async () => {
    const cookie = await harness.signIn(createWallet());
    for (const origin of ['https://evil.example', undefined]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: { cookie, ...(origin === undefined ? {} : { origin }) },
        payload: DRAFT,
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('CSRF_ORIGIN');
    }
    const count = await harness.admin.query('SELECT 1 FROM tasks');
    expect(count.rowCount).toBe(0);
  });
});

describe('verifyWalletSignature', () => {
  it('rejects malformed keys and signatures instead of throwing', () => {
    const wallet = createWallet();
    const signature = wallet.signMessage('hello');
    expect(verifyWalletSignature(wallet.address, 'hello', signature)).toBe(true);
    expect(verifyWalletSignature(wallet.address, 'hello!', signature)).toBe(false);
    expect(verifyWalletSignature('not-base58-0OIl', 'hello', signature)).toBe(false);
    expect(verifyWalletSignature(wallet.address, 'hello', 'abc')).toBe(false);
    expect(verifyWalletSignature(wallet.address.slice(0, 20), 'hello', signature)).toBe(false);
  });
});
