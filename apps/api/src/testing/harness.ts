// Test harness: the real application and a real PostgreSQL database, with the
// chain and the clock under the test's control.

import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  createTaskraConfig,
  findEscrowAddress,
  type TaskAccount,
  type TaskraConfig,
  TOKEN_PROGRAM_ID,
} from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { type TestDatabase, testDatabase } from '@taskra/shared/testing/postgres';
import bs58 from 'bs58';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/challenge.js';
import type { InnerInstruction } from '../chain/parse.js';
import type { ApiConfig } from '../config.js';
import type { AppDeps } from '../deps.js';
import { FakeChain } from './fake-chain.js';

export const WEB_ORIGIN = 'http://localhost:3000';

// Syntactically valid addresses with no key behind them.
const USDC_MINT = new PublicKey(new Uint8Array(32).fill(7));
export const TREASURY = new PublicKey(new Uint8Array(32).fill(9));

export interface TestWallet {
  readonly address: string;
  readonly publicKey: PublicKey;
  /** Signs a login message the way a wallet's signMessage would. */
  signMessage(message: string): string;
}

export function createWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return walletFrom(new PublicKey(raw), privateKey);
}

function walletFrom(publicKey: PublicKey, privateKey: KeyObject): TestWallet {
  return {
    address: publicKey.toBase58(),
    publicKey,
    signMessage: (message) => bs58.encode(sign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

export function randomSignature(): string {
  return bs58.encode(randomBytes(64));
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly deps: AppDeps;
  readonly chain: FakeChain;
  readonly taskra: TaskraConfig;
  /** Connections as the database owner, for assertions and fixtures the API role cannot write. */
  readonly admin: pg.Pool;
  readonly databaseUrl: string;
  /** Moves the application clock forward. */
  advance(seconds: number): void;
  get(url: string, cookie?: string): Promise<LightMyRequestResponse>;
  post(url: string, body: unknown, cookie?: string): Promise<LightMyRequestResponse>;
  /** Completes the login flow and returns the session cookie header value. */
  signIn(wallet: TestWallet): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly rateLimit?: boolean;
  readonly fetch?: typeof fetch;
  readonly github?: boolean;
  /** Defaults to `WEB_ORIGIN` (http on localhost). */
  readonly webOrigin?: string;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database: TestDatabase = await testDatabase();
  const taskra = createTaskraConfig({ cluster: 'localnet', usdcMint: USDC_MINT });
  const config: ApiConfig = {
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    WEB_ORIGIN: options.webOrigin ?? WEB_ORIGIN,
    SOLANA_NETWORK: 'localnet',
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    TASKRA_PROGRAM_ID: taskra.programId.toBase58(),
    USDC_MINT: USDC_MINT.toBase58(),
    DATABASE_URL: database.url,
    ...(options.github === true
      ? { GITHUB_CLIENT_ID: 'test-client-id', GITHUB_CLIENT_SECRET: 'test-client-secret' }
      : {}),
  };

  let clock = new Date('2026-10-09T12:00:00.000Z').getTime();
  const chain = new FakeChain();
  const pool = createPool(database.url, 'taskra_api');
  const admin = new pg.Pool({ connectionString: database.url, max: 4 });
  const deps: AppDeps = {
    config,
    taskra,
    pool,
    chain,
    fetch:
      options.fetch ?? (() => Promise.reject(new Error('unexpected outbound request in a test'))),
    now: () => new Date(clock),
    logger: false,
    rateLimit: options.rateLimit ?? false,
  };
  const app = await buildApp(deps);
  await app.ready();

  const headers = (cookie?: string) => ({
    origin: options.webOrigin ?? WEB_ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  });
  const harness: Harness = {
    app,
    deps,
    chain,
    taskra,
    admin,
    databaseUrl: database.url,
    advance: (seconds) => {
      clock += seconds * 1000;
    },
    get: (url, cookie) => app.inject({ method: 'GET', url, headers: headers(cookie) }),
    post: (url, body, cookie) =>
      app.inject({ method: 'POST', url, headers: headers(cookie), payload: body as object }),
    signIn: async (wallet) => {
      const challenge = await harness.post('/api/v1/auth/challenge', { wallet: wallet.address });
      const { nonce, message } = challenge.json<{ nonce: string; message: string }>();
      const verified = await harness.post('/api/v1/auth/verify', {
        nonce,
        signature: wallet.signMessage(message),
      });
      if (verified.statusCode !== 200) throw new Error(`sign-in failed: ${verified.body}`);
      const cookie = verified.cookies.find((entry) => entry.name === SESSION_COOKIE);
      if (cookie === undefined) throw new Error('no session cookie was set');
      return `${SESSION_COOKIE}=${cookie.value}`;
    },
    close: async () => {
      await app.close();
      await pool.end();
      await admin.end();
      await database.drop();
    },
  };
  return harness;
}

export interface TaskJson {
  readonly id: string;
  readonly taskAddress: string;
  readonly termsHash: string;
  readonly amount: string;
  readonly workDuration: string;
  readonly state: string;
  readonly clientWallet: string;
}

export const DRAFT = {
  title: 'Build a Solana transaction parser',
  description: 'Parse a transaction signature into structured output.',
  repo: 'octo-org/parser',
  acceptanceCriteria: 'Parses transaction signatures\nReturns structured output',
  workDuration: '172800',
  amount: '100000000',
};

export async function createDraft(
  harness: Harness,
  cookie: string,
  overrides: Partial<typeof DRAFT> = {},
): Promise<TaskJson> {
  const response = await harness.post('/api/v1/tasks', { ...DRAFT, ...overrides }, cookie);
  if (response.statusCode !== 201) throw new Error(`draft failed: ${response.body}`);
  return response.json<{ task: TaskJson }>().task;
}

const ZERO_HASH = new Uint8Array(32);

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** The Task account `create_and_fund_task` writes for this draft: state OPEN. */
export function openAccount(task: TaskJson, patch: Partial<TaskAccount> = {}): TaskAccount {
  return {
    taskId: fromHex(task.id.replaceAll('-', '')),
    client: new PublicKey(task.clientWallet),
    developer: null,
    amount: BigInt(task.amount),
    feeBps: 250,
    termsHash: fromHex(task.termsHash),
    state: 'OPEN',
    outcome: 'NONE',
    workDuration: BigInt(task.workDuration),
    createdAt: 1_760_000_000n,
    acceptedAt: 0n,
    workDeadline: 0n,
    verificationDeadline: 0n,
    submissionNonce: 0n,
    evidenceHash: ZERO_HASH,
    submittedAt: 0n,
    disputeOpenAt: 0n,
    refundOpenAt: 0n,
    attestedNonce: 0n,
    attestedHash: ZERO_HASH,
    verifiedAt: 0n,
    reviewDeadline: 0n,
    disputedAt: 0n,
    disputeDeadline: 0n,
    rejectionReasonHash: ZERO_HASH,
    closedAt: 0n,
    bump: 255,
    escrowBump: 255,
    ...patch,
  };
}

/** SPL Token `TransferChecked` as it appears among a transaction's inner instructions. */
export function tokenTransferChecked(
  source: string,
  mint: string,
  destination: string,
  authority: string,
  amount: bigint,
): InnerInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = 6;
  return {
    programId: TOKEN_PROGRAM_ID.toBase58(),
    accounts: [source, mint, destination, authority],
    data,
  };
}

/** SPL Token `CloseAccount` as an inner instruction. */
export function tokenCloseAccount(
  account: string,
  destination: string,
  authority: string,
): InnerInstruction {
  return {
    programId: TOKEN_PROGRAM_ID.toBase58(),
    accounts: [account, destination, authority],
    data: Uint8Array.of(9),
  };
}

/**
 * The inner instructions of a real outcome instruction: one transfer out of the
 * task's escrow per payout, signed by the Task PDA, then the escrow's closure.
 */
export function settlementInner(
  harness: Harness,
  task: TaskJson,
  payouts: readonly (readonly [destination: string, amount: bigint])[],
): InnerInstruction[] {
  const escrow = escrowOf(harness, task);
  const mint = harness.taskra.usdcMint.toBase58();
  return [
    ...payouts.map(([destination, amount]) =>
      tokenTransferChecked(escrow, mint, destination, task.taskAddress, amount),
    ),
    tokenCloseAccount(escrow, task.clientWallet, task.taskAddress),
  ];
}

export function escrowOf(harness: Harness, task: TaskJson): string {
  return findEscrowAddress(harness.taskra.programId, new PublicKey(task.taskAddress))[0].toBase58();
}
