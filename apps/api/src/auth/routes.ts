import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { ApiError, unauthorized } from '../errors.js';
import { signatureSchema, walletSchema } from '../validation.js';
import {
  buildChallengeMessage,
  CHALLENGE_TTL_SECONDS,
  randomToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sha256Hex,
  verifyWalletSignature,
} from './challenge.js';

export interface Session {
  readonly wallet: string;
  readonly expiresAt: Date;
  readonly tokenHash: string;
}

/** The session named by the request's cookie, or `null`. A wallet in a body is never one. */
export async function findSession(deps: AppDeps, request: FastifyRequest): Promise<Session | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined || token.length !== 43) return null;
  const tokenHash = sha256Hex(token);
  const result = await deps.pool.query<{ wallet: string; expires_at: Date }>(
    `SELECT wallet, expires_at FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, deps.now()],
  );
  const row = result.rows[0];
  return row === undefined ? null : { wallet: row.wallet, expiresAt: row.expires_at, tokenHash };
}

export async function requireSession(deps: AppDeps, request: FastifyRequest): Promise<Session> {
  const session = await findSession(deps, request);
  if (session === null) throw unauthorized();
  return session;
}

const AUTH_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };

const challengeBody = z.strictObject({ wallet: walletSchema });
const verifyBody = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: signatureSchema,
});

function cookieOptions(deps: AppDeps) {
  return {
    httpOnly: true,
    // The web app and the API must share a site; the cookie never rides a cross-site request.
    sameSite: 'strict',
    secure: deps.config.NODE_ENV === 'production',
    path: '/',
  } as const;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool, config } = deps;

  app.post('/api/v1/auth/challenge', { config: AUTH_RATE_LIMIT }, async (request) => {
    const { wallet } = challengeBody.parse(request.body);
    const issuedAt = deps.now();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000);
    const nonce = randomToken();
    const message = buildChallengeMessage({
      webOrigin: new URL(config.WEB_ORIGIN).origin,
      network: config.SOLANA_NETWORK,
      wallet,
      nonce,
      issuedAt,
      expiresAt,
    });
    await pool.query(
      `INSERT INTO auth_nonces (nonce, wallet, message, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [nonce, wallet, message, issuedAt, expiresAt],
    );
    // Opportunistic cleanup; correctness never depends on it.
    await pool.query(`DELETE FROM auth_nonces WHERE expires_at < $1`, [
      new Date(issuedAt.getTime() - 60 * 60 * 1000),
    ]);
    return { nonce, message, expiresAt: expiresAt.toISOString() };
  });

  app.post(
    '/api/v1/auth/verify',
    { config: AUTH_RATE_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { nonce, signature } = verifyBody.parse(request.body);
      const now = deps.now();

      // Consume first, verify second: whatever happens next, this nonce is spent.
      const consumed = await pool.query<{ wallet: string; message: string }>(
        `UPDATE auth_nonces SET consumed_at = $2
          WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING wallet, message`,
        [nonce, now],
      );
      const challenge = consumed.rows[0];
      if (challenge === undefined) {
        throw new ApiError(
          401,
          'INVALID_CHALLENGE',
          'The sign-in challenge is unknown, expired or already used. Request a new one.',
        );
      }
      if (!verifyWalletSignature(challenge.wallet, challenge.message, signature)) {
        throw new ApiError(401, 'INVALID_SIGNATURE', 'The signature does not match the wallet.');
      }

      const token = randomToken();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
      await pool.query(`INSERT INTO wallets (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        challenge.wallet,
      ]);
      await pool.query(
        `INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
        [sha256Hex(token), challenge.wallet, now, expiresAt],
      );
      await pool.query(`DELETE FROM sessions WHERE expires_at < $1`, [
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
      ]);

      void reply.setCookie(SESSION_COOKIE, token, {
        ...cookieOptions(deps),
        maxAge: SESSION_TTL_SECONDS,
      });
      return { wallet: challenge.wallet, expiresAt: expiresAt.toISOString() };
    },
  );

  app.get('/api/v1/auth/session', async (request) => {
    const session = await requireSession(deps, request);
    const github = await pool.query<{ login: string }>(
      `SELECT login FROM github_accounts WHERE wallet = $1`,
      [session.wallet],
    );
    return {
      wallet: session.wallet,
      expiresAt: session.expiresAt.toISOString(),
      github: github.rows[0] === undefined ? null : { login: github.rows[0].login },
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await findSession(deps, request);
    if (session !== null) {
      await pool.query(`UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1`, [
        session.tokenHash,
        deps.now(),
      ]);
    }
    void reply.clearCookie(SESSION_COOKIE, cookieOptions(deps));
    return { ok: true };
  });
}
