// One user: a wallet and a browser. The wallet (a test keypair) signs the
// login message and every transaction, exactly where a real wallet would; the
// API only ever receives signatures of transactions the actor already sent.

import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { buildUnsignedTransaction, decodeProgramError } from '@taskra/sdk';
import bs58 from 'bs58';
import { airdrop } from '../../../packages/sdk/e2e/lib.js';
import type { FakeUser } from './fake-github.js';
import { WEB_ORIGIN, type World } from './world.js';

// DER prefix of an Ed25519 PKCS#8 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ApiResponse<Body> {
  readonly status: number;
  readonly body: Body;
  readonly location: string | null;
}

/** The parts of a task response the scenarios read. */
export interface TaskView {
  readonly id: string;
  readonly state: string;
  readonly taskAddress: string;
  readonly termsHash: string;
  readonly termsVerified: boolean | null;
  readonly developerWallet: string | null;
  readonly chainSource: string;
  readonly chain: {
    readonly state: string;
    readonly outcome: string;
    readonly evidenceHash: string | null;
    readonly submissionNonce: string;
    readonly hasValidAttestation: boolean;
    readonly termsVerified: boolean;
    readonly times: Record<string, string | null>;
  } | null;
  readonly transactions: readonly {
    signature: string;
    instruction: string;
    status: string;
    error: string | null;
  }[];
  readonly settlement: {
    readonly signature: string;
    readonly state: string;
    readonly outcome: string;
    readonly feeAmount: string;
    readonly developerAmount: string;
    readonly clientAmount: string;
  } | null;
  readonly rejection: { readonly reason: string } | null;
  readonly verification: readonly {
    readonly submissionNonce: string;
    readonly status: string;
    readonly result: {
      rules: { rule: string; passed: boolean | null }[];
      headSha: string | null;
      mergeCommitSha: string | null;
    } | null;
    readonly attestation: { status: string; signature: string | null; error: string | null } | null;
  }[];
}

export interface ReportBody {
  readonly transaction: { status: string; instruction: string; error: string | null };
  readonly task: TaskView;
}

export class Actor {
  readonly keypair = Keypair.generate();
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly world: World,
    readonly name: string,
  ) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async prepare(): Promise<this> {
    await airdrop(this.world.connection, this.publicKey, 5);
    return this;
  }

  async request<Body = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<Body>> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${this.world.apiUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        origin: WEB_ORIGIN,
        ...(cookie === '' ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    const parsed = text === '' || response.status === 302 ? null : (JSON.parse(text) as unknown);
    return {
      status: response.status,
      body: parsed as Body,
      location: response.headers.get('location'),
    };
  }

  /** A request that must succeed. */
  async call<Body>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Body> {
    const response = await this.request<Body>(method, path, body);
    if (response.status >= 300) {
      throw new Error(
        `${this.name}: ${method} ${path} answered ${String(response.status)} ${JSON.stringify(response.body)}`,
      );
    }
    return response.body;
  }

  signMessage(message: string): string {
    const key = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, this.keypair.secretKey.subarray(0, 32)]),
      format: 'der',
      type: 'pkcs8',
    });
    return bs58.encode(sign(null, Buffer.from(message, 'utf8'), key));
  }

  async signIn(): Promise<void> {
    const challenge = await this.call<{ nonce: string; message: string }>(
      'POST',
      '/api/v1/auth/challenge',
      { wallet: this.address },
    );
    await this.call('POST', '/api/v1/auth/verify', {
      nonce: challenge.nonce,
      signature: this.signMessage(challenge.message),
    });
  }

  /** Walks the OAuth flow as a browser would, with the fake GitHub approving as `user`. */
  async linkGithub(user: FakeUser): Promise<string | null> {
    const started = await this.request('GET', '/api/v1/github/connect');
    const state = new URL(started.location ?? '').searchParams.get('state') ?? '';
    const code = this.world.github.authorizationCode(user);
    const finished = await this.request(
      'GET',
      `/api/v1/github/callback?code=${code}&state=${state}`,
    );
    return finished.location;
  }

  /**
   * Builds a transaction through the SDK, signs it with this wallet, sends it
   * and waits for `confirmed`. Returns the signature.
   */
  async send(
    instructions: readonly TransactionInstruction[],
    options: { skipPreflight?: boolean } = {},
  ): Promise<string> {
    const { connection } = this.world;
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = buildUnsignedTransaction({
      feePayer: this.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    });
    transaction.sign([this.keypair]);
    const signature = await connection.sendTransaction(transaction, {
      preflightCommitment: 'confirmed',
      skipPreflight: options.skipPreflight ?? false,
    });
    const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    if (result.value.err !== null && options.skipPreflight !== true) {
      throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
    }
    return signature;
  }

  /** Sends a transaction the cluster must refuse, and returns why. */
  async sendExpectingRefusal(instructions: readonly TransactionInstruction[]): Promise<string> {
    try {
      await this.send(instructions);
    } catch (error) {
      const decoded = decodeProgramError(error);
      if (decoded !== null && decoded.kind !== 'unknown') return decoded.name;
      const logs = (error as { logs?: string[] }).logs?.join('\n') ?? String(error);
      const reason =
        /Error: ([^\n]+)/.exec(logs)?.[1] ?? /custom program error: \w+/.exec(logs)?.[0];
      return reason ?? 'refused';
    }
    throw new Error('the cluster accepted a transaction it should have refused');
  }

  task(id: string): Promise<TaskView> {
    return this.call<{ task: TaskView }>('GET', `/api/v1/tasks/${id}`).then((body) => body.task);
  }

  report(id: string, route: string, body: unknown): Promise<ReportBody> {
    return this.call<ReportBody>('POST', `/api/v1/tasks/${id}/${route}`, body);
  }
}
