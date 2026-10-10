// Links a GitHub identity to a wallet through GitHub's OAuth web flow. The
// access token is used once, to ask GitHub who the user is, and is discarded:
// it is never stored, logged or returned. No scope is requested.

import type { FastifyInstance } from 'fastify';
import { isUniqueViolation } from '@taskra/shared/db';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../auth/challenge.js';
import { requireSession } from '../auth/routes.js';
import { servedOverHttps } from '../config.js';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../errors.js';

const STATE_TTL_SECONDS = 10 * 60;
const GITHUB_TIMEOUT_MS = 10_000;

const callbackQuery = z.object({
  code: z.string().min(1).max(200),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const tokenResponse = z.object({ access_token: z.string().min(1) });
const userResponse = z.object({ id: z.number().int().positive(), login: z.string().min(1) });

export function registerGithubRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool, config } = deps;
  const webOrigin = new URL(config.WEB_ORIGIN).origin;
  const secure = servedOverHttps(config);
  // Over https the name carries the `__Host-` prefix. A browser accepts such a
  // cookie only from this exact host, with `Secure`, `Path=/` and no `Domain`,
  // so a sibling subdomain cannot plant a state of its own choosing here.
  const STATE_COOKIE = secure ? '__Host-taskra_oauth_state' : 'taskra_oauth_state';
  const stateCookie = {
    httpOnly: true,
    // Lax, not strict: GitHub's redirect back is a cross-site top-level navigation.
    sameSite: 'lax',
    secure,
    path: '/',
  } as const;

  function credentials(): { id: string; secret: string } {
    if (config.GITHUB_CLIENT_ID === undefined || config.GITHUB_CLIENT_SECRET === undefined) {
      throw new ApiError(
        503,
        'GITHUB_NOT_CONFIGURED',
        'GitHub sign-in is not configured on this deployment.',
      );
    }
    return { id: config.GITHUB_CLIENT_ID, secret: config.GITHUB_CLIENT_SECRET };
  }

  // A top-level navigation from the web app. The session cookie is sent because
  // the web app and the API share a site.
  app.get('/api/v1/github/connect', async (request, reply) => {
    const session = await requireSession(deps, request);
    const { id } = credentials();
    const state = randomToken();
    const now = deps.now();
    await pool.query(
      `INSERT INTO github_oauth_states (state_hash, wallet, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sha256Hex(state), session.wallet, now, new Date(now.getTime() + STATE_TTL_SECONDS * 1000)],
    );
    await pool.query(`DELETE FROM github_oauth_states WHERE expires_at < $1`, [
      new Date(now.getTime() - 60 * 60 * 1000),
    ]);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', id);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('allow_signup', 'false');
    void reply.setCookie(STATE_COOKIE, state, { ...stateCookie, maxAge: STATE_TTL_SECONDS });
    return reply.redirect(authorize.toString());
  });

  app.get('/api/v1/github/callback', async (request, reply) => {
    const { id, secret } = credentials();
    void reply.clearCookie(STATE_COOKIE, stateCookie);
    const back = (wallet: string | null, outcome: string) =>
      reply.redirect(
        wallet === null
          ? `${webOrigin}/?github=${outcome}`
          : `${webOrigin}/profile/${wallet}?github=${outcome}`,
      );

    const parsed = callbackQuery.safeParse(request.query);
    // The state must be the one this browser was given, and unused.
    if (!parsed.success || request.cookies[STATE_COOKIE] !== parsed.data.state) {
      return back(null, 'state_invalid');
    }
    const now = deps.now();
    const consumed = await pool.query<{ wallet: string }>(
      `UPDATE github_oauth_states SET consumed_at = $2
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING wallet`,
      [sha256Hex(parsed.data.state), now],
    );
    const wallet = consumed.rows[0]?.wallet;
    if (wallet === undefined) return back(null, 'state_invalid');

    let user: z.infer<typeof userResponse>;
    try {
      const exchange = await deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: id, client_secret: secret, code: parsed.data.code }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      const { access_token: accessToken } = tokenResponse.parse(await exchange.json());
      const profile = await deps.fetch('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'taskra-api',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (!profile.ok) throw new Error(`GitHub /user returned ${String(profile.status)}`);
      user = userResponse.parse(await profile.json());
    } catch (error) {
      // Deliberately not logging the error object: it can carry response bodies.
      request.log.warn(
        { reason: error instanceof Error ? error.name : 'unknown' },
        'GitHub OAuth failed',
      );
      return back(wallet, 'exchange_failed');
    }

    try {
      await pool.query(
        `INSERT INTO github_accounts (wallet, github_user_id, login, linked_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet) DO UPDATE
           SET github_user_id = EXCLUDED.github_user_id, login = EXCLUDED.login,
               linked_at = EXCLUDED.linked_at`,
        [wallet, user.id, user.login, now],
      );
    } catch (error) {
      // That GitHub account is already linked to another wallet.
      if (isUniqueViolation(error)) return back(wallet, 'already_linked');
      throw error;
    }
    return back(wallet, 'linked');
  });
}
