// A stand-in for github.com and api.github.com, served through an injected
// `fetch`. It exists only in this test harness: the running services always
// talk to the real GitHub. It lets the suite control exactly what "GitHub"
// says about a pull request, including outages.

export interface FakeUser {
  readonly id: number;
  readonly login: string;
}

export interface FakePull {
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  author: FakeUser;
  mergedBy: FakeUser | null;
}

const REPO_CREATED_AT = '2020-01-01T00:00:00Z';

export class FakeGithub {
  /** When true every REST call answers 503. */
  outage = false;
  readonly requests: string[] = [];
  private readonly repositories = new Set<string>();
  private readonly pulls = new Map<string, FakePull>();
  private readonly users = new Map<string, FakeUser>();

  addRepository(repo: string): void {
    this.repositories.add(repo);
  }

  setPull(repo: string, number: bigint, pull: FakePull): void {
    this.pulls.set(`${repo}#${number.toString()}`, pull);
  }

  /** An OAuth `code` that, when exchanged, identifies `user`. */
  authorizationCode(user: FakeUser): string {
    const code = `code-${String(user.id)}`;
    this.users.set(code, user);
    return code;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    this.requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    return Promise.resolve(this.route(url, init));
  };

  private route(url: URL, init: RequestInit | undefined): Response {
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        code?: string;
      };
      const known = body.code !== undefined && this.users.has(body.code);
      return Response.json(
        known ? { access_token: `token-for-${body.code ?? ''}` } : { error: 'bad_code' },
      );
    }
    if (url.origin !== 'https://api.github.com') return new Response('not found', { status: 404 });

    if (url.pathname === '/user') {
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      const user = this.users.get(token.replace('token-for-', ''));
      return user === undefined
        ? Response.json({ message: 'Bad credentials' }, { status: 401 })
        : Response.json(user);
    }
    if (this.outage) return Response.json({ message: 'Service unavailable' }, { status: 503 });

    const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (pull?.[1] !== undefined && pull[2] !== undefined) {
      const found = this.pulls.get(`${pull[1]}#${pull[2]}`);
      if (found === undefined || !this.repositories.has(pull[1])) {
        return Response.json({ message: 'Not Found' }, { status: 404 });
      }
      return Response.json({
        number: Number(pull[2]),
        merged: found.merged,
        merged_at: found.mergedAt,
        merge_commit_sha: found.mergeCommitSha,
        user: found.author,
        merged_by: found.mergedBy,
        head: { sha: found.headSha },
        base: { repo: { full_name: pull[1], created_at: REPO_CREATED_AT } },
      });
    }
    const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (repository?.[1] !== undefined && this.repositories.has(repository[1])) {
      return Response.json({ full_name: repository[1], created_at: REPO_CREATED_AT });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
}
