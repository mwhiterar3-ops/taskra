import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createWallet, type Harness, WEB_ORIGIN } from '../testing/harness.js';

const STATE_COOKIE = 'taskra_oauth_state';

interface FakeGithub {
  fetch: typeof fetch;
  /** What `GET /user` answers for the next exchange. */
  user: { id: number; login: string };
  failExchange: boolean;
  requests: { url: string; body: string | null; authorization: string | null }[];
}

function fakeGithub(): FakeGithub {
  const fake: FakeGithub = {
    user: { id: 1001, login: 'dev-octocat' },
    failExchange: false,
    requests: [],
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(init?.headers);
      fake.requests.push({
        url,
        body: typeof init?.body === 'string' ? init.body : null,
        authorization: headers.get('authorization'),
      });
      if (url === 'https://github.com/login/oauth/access_token') {
        return Promise.resolve(
          Response.json(
            fake.failExchange ? { error: 'bad_verification_code' } : { access_token: 'gho_test' },
          ),
        );
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(Response.json({ ...fake.user, email: 'ignored@example.com' }));
      }
      return Promise.reject(new Error(`unexpected request to ${url}`));
    },
  };
  return fake;
}

let github: FakeGithub;
let harness: Harness;
beforeAll(async () => {
  github = fakeGithub();
  harness = await createHarness({ github: true, fetch: github.fetch });
});
afterAll(async () => {
  await harness.close();
});

interface Started {
  state: string;
  stateCookie: string;
}

async function connect(sessionCookie: string): Promise<Started> {
  const response = await harness.get('/api/v1/github/connect', sessionCookie);
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location ?? '');
  const cookie = response.cookies.find((entry) => entry.name === STATE_COOKIE);
  expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(location.searchParams.get('client_id')).toBe('test-client-id');
  expect(location.searchParams.get('scope')).toBeNull();
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  const state = location.searchParams.get('state') ?? '';
  expect(cookie?.value).toBe(state);
  return { state, stateCookie: `${STATE_COOKIE}=${state}` };
}

function callback(state: string, cookie?: string): Promise<LightMyRequestResponse> {
  // GitHub's redirect is a cross-site navigation: no Origin, no session cookie.
  return harness.app.inject({
    method: 'GET',
    url: `/api/v1/github/callback?code=the-code&state=${state}`,
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function linkedLogin(wallet: string): Promise<string | null> {
  const user = await harness.get(`/api/v1/users/${wallet}`);
  return user.json<{ github: { login: string } | null }>().github?.login ?? null;
}

describe('linking a GitHub identity', () => {
  it('requires a session to start', async () => {
    expect((await harness.get('/api/v1/github/connect')).statusCode).toBe(401);
  });

  it('links the GitHub account GitHub reports, and stores no token', async () => {
    const wallet = createWallet();
    const session = await harness.signIn(wallet);
    const { state, stateCookie } = await connect(session);

    const response = await callback(state, stateCookie);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${WEB_ORIGIN}/profile/${wallet.address}?github=linked`);
    expect(await linkedLogin(wallet.address)).toBe('dev-octocat');

    const exchange = github.requests.find((request) => request.url.includes('access_token'));
    expect(JSON.parse(exchange?.body ?? '{}')).toMatchObject({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      code: 'the-code',
    });
    const dump = await harness.admin.query(
      `SELECT row_to_json(g)::text AS row FROM github_accounts g WHERE wallet = $1`,
      [wallet.address],
    );
    expect(dump.rows[0]).toBeDefined();
    expect(JSON.stringify(dump.rows)).not.toContain('gho_test');
  });

  it('accepts each state once', async () => {
    const session = await harness.signIn(createWallet());
    const { state, stateCookie } = await connect(session);
    github.user = { id: 1002, login: 'second' };
    expect((await callback(state, stateCookie)).headers.location).toContain('github=linked');
    const replay = await callback(state, stateCookie);
    expect(replay.headers.location).toBe(`${WEB_ORIGIN}/?github=state_invalid`);
  });

  it('refuses a callback from a browser that did not start the flow', async () => {
    const victim = createWallet();
    const session = await harness.signIn(victim);
    const { state } = await connect(session);
    github.user = { id: 6666, login: 'attacker' };

    const noCookie = await callback(state);
    expect(noCookie.headers.location).toBe(`${WEB_ORIGIN}/?github=state_invalid`);
    const otherCookie = await callback(state, `${STATE_COOKIE}=${'A'.repeat(43)}`);
    expect(otherCookie.headers.location).toBe(`${WEB_ORIGIN}/?github=state_invalid`);
    expect(await linkedLogin(victim.address)).toBeNull();
  });

  it('refuses an expired or malformed state', async () => {
    const wallet = createWallet();
    const session = await harness.signIn(wallet);
    const { state, stateCookie } = await connect(session);
    harness.advance(10 * 60 + 1);
    expect((await callback(state, stateCookie)).headers.location).toContain('state_invalid');
    expect((await callback('short', `${STATE_COOKIE}=short`)).headers.location).toContain(
      'state_invalid',
    );
    expect(await linkedLogin(wallet.address)).toBeNull();
  });

  it('links nothing when GitHub rejects the code', async () => {
    const wallet = createWallet();
    const session = await harness.signIn(wallet);
    const { state, stateCookie } = await connect(session);
    github.failExchange = true;
    const response = await callback(state, stateCookie);
    github.failExchange = false;
    expect(response.headers.location).toBe(
      `${WEB_ORIGIN}/profile/${wallet.address}?github=exchange_failed`,
    );
    expect(await linkedLogin(wallet.address)).toBeNull();
  });

  it('allows one wallet per GitHub account, and lets a wallet change its link', async () => {
    const first = createWallet();
    const second = createWallet();
    github.user = { id: 3003, login: 'shared-account' };

    const a = await connect(await harness.signIn(first));
    expect((await callback(a.state, a.stateCookie)).headers.location).toContain('github=linked');

    const secondSession = await harness.signIn(second);
    const b = await connect(secondSession);
    expect((await callback(b.state, b.stateCookie)).headers.location).toContain(
      'github=already_linked',
    );
    expect(await linkedLogin(second.address)).toBeNull();

    github.user = { id: 4004, login: 'own-account' };
    const c = await connect(secondSession);
    await callback(c.state, c.stateCookie);
    expect(await linkedLogin(second.address)).toBe('own-account');
  });
});

// L-10: a page on a sibling subdomain can set cookies for the parent domain.
// With a state cookie it could set, it could make a victim's browser finish a
// flow the attacker started, linking the victim's GitHub account to the
// attacker's wallet.
describe('on an https origin', () => {
  const ORIGIN = 'https://app.taskra.example';
  const PREFIXED = '__Host-taskra_oauth_state';

  it('uses a state cookie that only this host can set', async () => {
    const secure = await createHarness({ github: true, fetch: github.fetch, webOrigin: ORIGIN });
    try {
      const wallet = createWallet();
      const started = await secure.get('/api/v1/github/connect', await secure.signIn(wallet));
      expect(started.statusCode).toBe(302);
      expect(started.cookies.map((entry) => entry.name)).toEqual([PREFIXED]);
      const [cookie] = started.cookies;
      // What the prefix requires of the cookie, or a browser discards it.
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect(cookie).not.toHaveProperty('domain');
      const state = new URL(started.headers.location ?? '').searchParams.get('state') ?? '';

      const finish = (cookieHeader: string) =>
        secure.app.inject({
          method: 'GET',
          url: `/api/v1/github/callback?code=the-code&state=${state}`,
          headers: { cookie: cookieHeader },
        });
      // The name a sibling subdomain could set is not the state cookie.
      const planted = await finish(`taskra_oauth_state=${state}`);
      expect(planted.headers.location).toBe(`${ORIGIN}/?github=state_invalid`);
      const user = await secure.get(`/api/v1/users/${wallet.address}`);
      expect(user.json<{ github: unknown }>().github).toBeNull();
    } finally {
      await secure.close();
    }
  });

  it('completes the flow with that cookie', async () => {
    const secure = await createHarness({ github: true, fetch: github.fetch, webOrigin: ORIGIN });
    try {
      const wallet = createWallet();
      const started = await secure.get('/api/v1/github/connect', await secure.signIn(wallet));
      const state = new URL(started.headers.location ?? '').searchParams.get('state') ?? '';
      const response = await secure.app.inject({
        method: 'GET',
        url: `/api/v1/github/callback?code=the-code&state=${state}`,
        headers: { cookie: `${PREFIXED}=${state}` },
      });
      expect(response.headers.location).toBe(`${ORIGIN}/profile/${wallet.address}?github=linked`);
    } finally {
      await secure.close();
    }
  });
});

describe('without a configured GitHub OAuth app', () => {
  it('answers 503 and does not redirect', async () => {
    const bare = await createHarness();
    try {
      const session = await bare.signIn(createWallet());
      const response = await bare.get('/api/v1/github/connect', session);
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('GITHUB_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
