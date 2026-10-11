import { describe, expect, it } from 'vitest';
import { createGithubClient } from './github.js';

const PULL = {
  number: 42,
  merged: true,
  merged_at: '2026-10-01T10:00:00Z',
  merge_commit_sha: '89ABCDEF0123456789abcdef0123456789abcdef',
  user: { id: 1001, login: 'dev-octocat', site_admin: false },
  merged_by: { id: 2002, login: 'maintainer' },
  head: { sha: '0123456789ABCDEF0123456789abcdef01234567', ref: 'feature' },
  base: {
    ref: 'main',
    repo: {
      full_name: 'Octo-Org/Parser',
      created_at: '2020-01-01T00:00:00Z',
      default_branch: 'main',
      private: false,
    },
  },
  // Untrusted extras a hostile repository controls; never read.
  title: '<script>alert(1)</script>',
  body: '$(rm -rf /)',
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return Promise.resolve(respond(url));
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'x-github-request-id': 'ABCD:1', 'x-ratelimit-remaining': '57' },
  });

describe('GitHub client', () => {
  it('returns only the validated fields of a pull request', async () => {
    const { fetch, requests } = fakeFetch(() => json(PULL));
    const result = await createGithubClient({ fetch }).getPullRequest('octo-org/parser', 42n);
    expect(result).toEqual({
      kind: 'ok',
      value: {
        number: 42,
        merged: true,
        mergedAt: '2026-10-01T10:00:00Z',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        mergeCommitSha: '89abcdef0123456789abcdef0123456789abcdef',
        author: { id: 1001, login: 'dev-octocat' },
        mergedBy: { id: 2002, login: 'maintainer' },
        baseRepo: 'Octo-Org/Parser',
        baseRepoCreatedAt: '2020-01-01T00:00:00Z',
        baseRef: 'main',
        baseDefaultBranch: 'main',
      },
      meta: {
        endpoint: 'GET /repos/octo-org/parser/pulls/42',
        status: 200,
        requestId: 'ABCD:1',
        rateLimitRemaining: '57',
      },
    });
    expect(requests[0]?.url).toBe('https://api.github.com/repos/octo-org/parser/pulls/42');
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('authenticates with the OAuth app credentials when given', async () => {
    const { fetch, requests } = fakeFetch(() => json(PULL));
    const client = createGithubClient({ fetch, credentials: { id: 'id', secret: 'secret' } });
    await client.getPullRequest('octo-org/parser', 42n);
    expect(requests[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
  });

  it('reports 404 as a fact', async () => {
    const { fetch } = fakeFetch(() => json({ message: 'Not Found' }, 404));
    const result = await createGithubClient({ fetch }).getRepository('gone/repo');
    expect(result.kind).toBe('not_found');
  });

  it.each([401, 403, 429, 500, 502, 503])(
    'reports HTTP %i as unavailable, never as a fact',
    async (status) => {
      const { fetch } = fakeFetch(() => json({ message: 'nope' }, status));
      const result = await createGithubClient({ fetch }).getPullRequest('octo-org/parser', 42n);
      expect(result).toMatchObject({ kind: 'unavailable', meta: { status } });
    },
  );

  it.each([
    ['malformed JSON', () => new Response('<html>oops</html>', { status: 200 })],
    ['a body missing required fields', () => json({ number: 42 })],
    ['a head SHA that is not a SHA', () => json({ ...PULL, head: { sha: 'HEAD; rm -rf /' } })],
    ['a non-numeric user id', () => json({ ...PULL, user: { id: '1001', login: 'x' } })],
  ])('reports %s as unavailable', async (_, respond) => {
    const { fetch } = fakeFetch(respond);
    const result = await createGithubClient({ fetch }).getPullRequest('octo-org/parser', 42n);
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'GitHub returned an unexpected response',
    });
  });

  it.each([500, 503, 403])(
    'does not accept a well-formed pull request delivered with HTTP %i',
    async (status) => {
      // The status decides, not the body: an error page that happens to parse
      // must never be read as GitHub's answer.
      const { fetch } = fakeFetch(() => json(PULL, status));
      const result = await createGithubClient({ fetch }).getPullRequest('octo-org/parser', 42n);
      expect(result.kind).toBe('unavailable');
    },
  );

  it('reports a network failure as unavailable', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const result = await createGithubClient({ fetch: fetchImpl }).getRepository('octo-org/parser');
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'GitHub could not be reached' });
  });

  it('gives up after the timeout and reports unavailable', async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const client = createGithubClient({ fetch: fetchImpl, timeoutMs: 20 });
    const result = await client.getPullRequest('octo-org/parser', 42n);
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'GitHub did not answer in time' });
  });

  it('returns a commit message for exactly the commit that was asked for', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const body = {
      sha: sha.toUpperCase(),
      commit: { message: 'Subject\n\nTaskra-Task: x' },
      files: [],
    };
    const { fetch, requests } = fakeFetch(() => json(body));
    const result = await createGithubClient({ fetch }).getCommit('octo-org/parser', sha);
    expect(result).toMatchObject({
      kind: 'ok',
      value: { sha, message: 'Subject\n\nTaskra-Task: x' },
    });
    expect(requests[0]?.url).toBe(`https://api.github.com/repos/octo-org/parser/commits/${sha}`);

    const other = fakeFetch(() => json({ ...body, sha: 'f'.repeat(40) }));
    const mismatch = await createGithubClient({ fetch: other.fetch }).getCommit(
      'octo-org/parser',
      sha,
    );
    expect(mismatch.kind).toBe('unavailable');

    const missing = fakeFetch(() => json({ message: 'Not Found' }, 404));
    expect(
      (await createGithubClient({ fetch: missing.fetch }).getCommit('octo-org/parser', sha)).kind,
    ).toBe('not_found');
  });

  it('parses a repository', async () => {
    const { fetch } = fakeFetch(() =>
      json({ full_name: 'octo-org/parser', created_at: '2020-01-01T00:00:00Z' }),
    );
    const result = await createGithubClient({ fetch }).getRepository('octo-org/parser');
    expect(result).toMatchObject({
      kind: 'ok',
      value: { fullName: 'octo-org/parser', createdAt: '2020-01-01T00:00:00Z' },
    });
  });
});
