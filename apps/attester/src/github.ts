// The only code in Taskra that talks to GitHub about evidence. Everything it
// returns is untrusted input: responses are validated field by field and are
// only ever compared, hashed and stored. Nothing fetched is executed.

import { z } from 'zod';

/** What the audit record keeps about one GitHub request. */
export interface GithubCallMeta {
  readonly endpoint: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly rateLimitRemaining: string | null;
}

/**
 * - `ok`: GitHub answered with the resource.
 * - `not_found`: GitHub answered that it does not exist (a fact).
 * - `unavailable`: no usable answer: outage, timeout, rate limit, revoked or
 *   missing access, malformed body. Never grounds for VERIFIED or REJECTED.
 */
export type GithubOutcome<Value> =
  | { readonly kind: 'ok'; readonly value: Value; readonly meta: GithubCallMeta }
  | { readonly kind: 'not_found'; readonly meta: GithubCallMeta }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly meta: GithubCallMeta };

export interface GithubUser {
  readonly id: number;
  readonly login: string;
}

export interface PullRequest {
  readonly number: number;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
  readonly author: GithubUser | null;
  readonly mergedBy: GithubUser | null;
  /** `owner/name` of the repository the pull request targets, as GitHub spells it. */
  readonly baseRepo: string;
  readonly baseRepoCreatedAt: string;
}

export interface Repository {
  readonly fullName: string;
  readonly createdAt: string;
}

export interface GithubClient {
  getPullRequest(repo: string, number: bigint): Promise<GithubOutcome<PullRequest>>;
  getRepository(repo: string): Promise<GithubOutcome<Repository>>;
}

const sha = z.string().regex(/^[0-9a-fA-F]{40}$/);
const user = z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) });
const timestamp = z.iso.datetime({ offset: true });

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
  merged_at: timestamp.nullable(),
  merge_commit_sha: sha.nullable(),
  user: user.nullable(),
  merged_by: user.nullable().optional(),
  head: z.object({ sha }),
  base: z.object({
    repo: z.object({ full_name: z.string().min(3).max(200), created_at: timestamp }),
  }),
});

const repositorySchema = z.object({
  full_name: z.string().min(3).max(200),
  created_at: timestamp,
});

export interface GithubClientOptions {
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
  /** OAuth app credentials. Used only to raise the public-API rate limit. */
  readonly credentials?: { readonly id: string; readonly secret: string };
  readonly timeoutMs?: number;
}

const MAX_BODY_BYTES = 1_000_000;

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const baseUrl = options.baseUrl ?? 'https://api.github.com';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'taskra-attester',
    'x-github-api-version': '2022-11-28',
  };
  if (options.credentials !== undefined) {
    const { id, secret } = options.credentials;
    headers['authorization'] = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }

  async function get<Value>(
    path: string,
    parse: (body: unknown) => Value,
  ): Promise<GithubOutcome<Value>> {
    const endpoint = `GET ${path}`;
    let response: Response;
    try {
      response = await options.fetch(`${baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        kind: 'unavailable',
        reason: timedOut ? 'GitHub did not answer in time' : 'GitHub could not be reached',
        meta: { endpoint, status: null, requestId: null, rateLimitRemaining: null },
      };
    }
    const meta: GithubCallMeta = {
      endpoint,
      status: response.status,
      requestId: response.headers.get('x-github-request-id'),
      rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
    };
    if (response.status === 404) return { kind: 'not_found', meta };
    if (response.status !== 200) {
      // 401/403 (revoked or missing access, rate limit), 429, 5xx, and anything else.
      return {
        kind: 'unavailable',
        reason: `GitHub answered ${String(response.status)}`,
        meta,
      };
    }
    try {
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
      return { kind: 'ok', value: parse(JSON.parse(text)), meta };
    } catch {
      return { kind: 'unavailable', reason: 'GitHub returned an unexpected response', meta };
    }
  }

  return {
    getPullRequest: (repo, number) =>
      get(`/repos/${repo}/pulls/${number.toString()}`, (body) => {
        const pr = pullRequestSchema.parse(body);
        return {
          number: pr.number,
          merged: pr.merged,
          mergedAt: pr.merged_at,
          headSha: pr.head.sha.toLowerCase(),
          mergeCommitSha: pr.merge_commit_sha?.toLowerCase() ?? null,
          author: pr.user,
          mergedBy: pr.merged_by ?? null,
          baseRepo: pr.base.repo.full_name,
          baseRepoCreatedAt: pr.base.repo.created_at,
        };
      }),
    getRepository: (repo) =>
      get(`/repos/${repo}`, (body) => {
        const repository = repositorySchema.parse(body);
        return { fullName: repository.full_name, createdAt: repository.created_at };
      }),
  };
}
