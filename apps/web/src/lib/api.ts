// Client for the Taskra API. The API supplies metadata and its own observations
// of the chain; the browser never treats those as authoritative for money.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly repo: string;
  readonly acceptanceCriteria: string;
  readonly workDuration: string;
  readonly amount: string;
  readonly termsHash: string;
  readonly taskAddress: string;
  readonly clientWallet: string;
  readonly createdAt: string;
  readonly state: string;
  readonly developerWallet: string | null;
  readonly termsVerified: boolean | null;
  readonly observed: { commitment: string; slot: string; at: string | null } | null;
}

export interface RuleResult {
  readonly rule: string;
  readonly passed: boolean | null;
  readonly reason: string;
}

export interface VerificationEntry {
  readonly submissionNonce: string;
  readonly evidenceHash: string;
  readonly prNumber: string;
  readonly status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  readonly job: { status: string; attempts: number } | null;
  readonly result: {
    checkedAt: string | null;
    rules: RuleResult[];
    headSha: string | null;
    mergeCommitSha: string | null;
    prAuthor: string | null;
    mergedBy: string | null;
    mergedAt: string | null;
  } | null;
  readonly attestation: { status: string; signature: string | null; error: string | null } | null;
}

export interface TaskDetail extends TaskSummary {
  readonly chainSource: 'live' | 'cache';
  readonly transactions: {
    signature: string;
    instruction: string;
    status: 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'DROPPED';
    blockTime: string | null;
    error: string | null;
  }[];
  readonly settlement: {
    signature: string;
    state: string;
    outcome: string;
    amount: string;
    feeAmount: string;
    developerAmount: string;
    clientAmount: string;
    closedAt: string;
  } | null;
  readonly rejection: { reason: string; reasonHash: string } | null;
  readonly verification: VerificationEntry[];
}

export interface Session {
  readonly wallet: string;
  readonly expiresAt: string;
  readonly github?: { login: string } | null;
}

export interface Reputation {
  readonly wallet: string;
  readonly developer: {
    tasksSettled: number;
    tasksRefunded: number;
    tasksDisputed: number;
    distinctClients: number;
    totalEarned: string;
  };
  readonly client: {
    tasksSettled: number;
    tasksRefunded: number;
    tasksCancelled: number;
    tasksDisputed: number;
    distinctDevelopers: number;
    totalPaid: string;
  };
  readonly reliableContributor: {
    label: string;
    qualified: boolean;
    requirement: { settledTasks: number; distinctClients: number };
  };
  readonly verifiedWork: {
    taskId: string;
    title: string;
    repo: string;
    developerAmount: string;
    signature: string;
    closedAt: string;
  }[];
}

export interface DraftInput {
  readonly title: string;
  readonly description: string;
  readonly repo: string;
  readonly acceptanceCriteria: string;
  readonly workDuration: string;
  readonly amount: string;
}

export interface Api {
  readonly baseUrl: string;
  challenge(wallet: string): Promise<{ nonce: string; message: string }>;
  verify(nonce: string, signature: string): Promise<Session>;
  session(): Promise<Session | null>;
  logout(): Promise<void>;
  listTasks(filter?: {
    state?: string;
    client?: string;
    developer?: string;
  }): Promise<TaskSummary[]>;
  createDraft(input: DraftInput): Promise<TaskSummary>;
  task(id: string): Promise<TaskDetail>;
  /** `route`: fund, accept, approve, reject, evidence or transactions. */
  report(id: string, route: string, body: unknown): Promise<TaskDetail>;
  user(
    wallet: string,
  ): Promise<{ wallet: string; registered: boolean; github: { login: string } | null }>;
  reputation(wallet: string): Promise<Reputation>;
}

export function createApi(baseUrl: string, fetchImpl: typeof fetch = fetch): Api {
  async function request<Body>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Body> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        // The session is an HttpOnly cookie; scripts never see it.
        credentials: 'include',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'The Taskra API could not be reached.');
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'UNKNOWN',
        error?.message ?? `The API answered ${String(response.status)}.`,
      );
    }
    return parsed as Body;
  }

  return {
    baseUrl,
    challenge: (wallet) => request('POST', '/api/v1/auth/challenge', { wallet }),
    verify: (nonce, signature) => request('POST', '/api/v1/auth/verify', { nonce, signature }),
    session: async () => {
      try {
        return await request<Session>('GET', '/api/v1/auth/session');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    logout: async () => {
      await request('POST', '/api/v1/auth/logout', {});
    },
    listTasks: async (filter = {}) => {
      const query = new URLSearchParams(Object.entries(filter));
      query.set('limit', '100');
      const body = await request<{ tasks: TaskSummary[] }>(
        'GET',
        `/api/v1/tasks?${query.toString()}`,
      );
      return body.tasks;
    },
    createDraft: async (input) =>
      (await request<{ task: TaskSummary }>('POST', '/api/v1/tasks', input)).task,
    task: async (id) => (await request<{ task: TaskDetail }>('GET', `/api/v1/tasks/${id}`)).task,
    report: async (id, route, body) =>
      (await request<{ task: TaskDetail }>('POST', `/api/v1/tasks/${id}/${route}`, body)).task,
    user: (wallet) => request('GET', `/api/v1/users/${wallet}`),
    reputation: (wallet) => request('GET', `/api/v1/users/${wallet}/reputation`),
  };
}
