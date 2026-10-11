// Issue #16: reject_task succeeds on-chain and the request that stores the
// reason text fails. The page must say so, keep the text, and let the client
// send it again without another transaction.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { type PlatformAccount, rejectionReasonHash, type TaskAccount, toHex } from '@taskra/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom installs its own Uint8Array, while Node's Buffer extends Node's. The
// Solana libraries check `instanceof Uint8Array` against the global, so under
// jsdom they refuse every buffer and can neither derive an address nor
// serialize a transaction. Pointing the global at Node's class lets these tests
// use the real instruction builder and a really signed transaction.
vi.hoisted(() => {
  const node = Object.getPrototypeOf(Buffer.prototype) as { constructor: typeof Uint8Array };
  globalThis.Uint8Array = node.constructor;
});

import type { TaskData } from '../hooks/use-task';
import { type Api, ApiError, type Session, type TaskDetail } from '../lib/api';
import { REJECTION_REASON_MAX } from '../lib/rejection';
import type { WalletPort } from '../lib/wallet';
import { AppProvider, createServices } from '../state/app-context';
import { FakeRpc, FakeWallet } from '../testing/fakes';
import { WalletPanel } from './Header';
import { TaskActions } from './TaskActions';

const ENV = {
  NEXT_PUBLIC_SOLANA_NETWORK: 'localnet',
  NEXT_PUBLIC_SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  // A real program address: the instruction builder derives PDAs from it.
  NEXT_PUBLIC_TASKRA_PROGRAM_ID: 'CCgMR2BZ7Hr4SiMRPYsY6yzZsGgddygjH3eF8A939mkZ',
  NEXT_PUBLIC_USDC_MINT: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  NEXT_PUBLIC_API_URL: 'http://localhost:4000',
} as const;

const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const REASON = 'The parser drops the last instruction.';
const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const ZERO = new Uint8Array(32);
const HASH = new Uint8Array(32).fill(9);

type Reply = (body: { signature: string; reason: string }) => Promise<TaskDetail>;

class FakeApi implements Partial<Api> {
  baseUrl = ENV.NEXT_PUBLIC_API_URL;
  current: Session | null = null;
  /** Every reason report received, in order. */
  reports: { route: string; signature: string; reason: string }[] = [];
  /** One reply per report; the last one repeats. */
  replies: Reply[] = [];

  session = () => Promise.resolve(this.current);
  challenge = (wallet: string) => Promise.resolve({ nonce: 'nonce', message: `sign in ${wallet}` });
  verify = () => {
    this.current = { wallet: this.wallet, expiresAt: 'later', github: null };
    return Promise.resolve(this.current);
  };
  report = (_id: string, route: string, body: unknown) => {
    const sent = body as { signature: string; reason: string };
    const reply = this.replies[Math.min(this.reports.length, this.replies.length - 1)];
    this.reports.push({ route, ...sent });
    if (reply === undefined) return Promise.reject(new Error('no reply scripted'));
    return reply(sent);
  };

  constructor(readonly wallet: string) {}
}

let wallet: FakeWallet;
let rpc: FakeRpc;
let api: FakeApi;
let refresh: ReturnType<typeof vi.fn<() => void>>;

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: TASK_ID,
    title: 'Parser',
    description: '',
    repo: 'octo-org/parser',
    acceptanceCriteria: 'Parses',
    workDuration: '900',
    amount: '100',
    termsHash: 'ab'.repeat(32),
    taskAddress: key(8).toBase58(),
    clientWallet: wallet.publicKey.toBase58(),
    createdAt: '2026-10-01T00:00:00Z',
    state: 'UNDER_REVIEW',
    developerWallet: key(2).toBase58(),
    termsVerified: true,
    observed: null,
    chainSource: 'live',
    transactions: [],
    settlement: null,
    rejection: null,
    verification: [],
    ...patch,
  };
}

/** What the API answers once it holds `reason`. */
const stored = (reason: string): Reply => {
  const reasonHash = toHex(rejectionReasonHash(reason));
  return () => Promise.resolve(detail({ rejection: { reason, reasonHash } }));
};
const fails =
  (error: Error): Reply =>
  () =>
    Promise.reject(error);

function mount() {
  const account: TaskAccount = {
    taskId: new Uint8Array(16),
    client: wallet.publicKey,
    developer: key(2),
    amount: 100n,
    feeBps: 250,
    termsHash: HASH,
    state: 'UNDER_REVIEW',
    outcome: 'NONE',
    workDuration: 900n,
    createdAt: 50n,
    acceptedAt: 100n,
    workDeadline: 1000n,
    verificationDeadline: 1100n,
    submissionNonce: 1n,
    evidenceHash: HASH,
    submittedAt: 500n,
    disputeOpenAt: 1200n,
    refundOpenAt: 1400n,
    attestedNonce: 1n,
    attestedHash: HASH,
    verifiedAt: 600n,
    reviewDeadline: 1300n,
    disputedAt: 0n,
    disputeDeadline: 0n,
    rejectionReasonHash: ZERO,
    closedAt: 0n,
    bump: 255,
    escrowBump: 255,
  };
  const platform: PlatformAccount = {
    authority: key(3),
    attester: key(4),
    treasury: key(5),
    usdcMint: new PublicKey(ENV.NEXT_PUBLIC_USDC_MINT),
    feeBps: 250,
    reviewWindow: 100n,
    verificationGrace: 100n,
    disputeTimeout: 100n,
    bump: 255,
  };
  const data: TaskData = {
    detail: detail(),
    account,
    platform,
    chainTime: 1250n,
    termsVerified: true,
    loading: false,
    notFound: false,
    problem: null,
    refresh,
  };
  const services = {
    ...createServices(ENV, api as unknown as Api),
    connection: rpc as unknown as Connection,
  };
  const discover = (onChange: (found: WalletPort[]) => void) => {
    onChange([wallet]);
    return () => undefined;
  };
  return render(
    <AppProvider services={services} discover={discover}>
      <WalletPanel />
      <TaskActions data={data} />
    </AppProvider>,
  );
}

const SLOW = { timeout: 8_000 };
const submitButton = () => screen.getByRole('button', { name: 'Reject and open dispute' });
const retryButton = () => screen.queryByRole('button', { name: 'Try saving the reason again' });
const phase = () => document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null;

/** Connects the wallet, types `reason` and submits the rejection. */
async function reject(reason = REASON) {
  mount();
  fireEvent.click(screen.getByRole('button', { name: `Connect ${wallet.name}` }));
  await screen.findByRole('button', { name: 'Reject and open dispute' });
  fireEvent.change(screen.getByRole('textbox', { name: /^Reason/ }), {
    target: { value: reason },
  });
  fireEvent.click(submitButton());
}

beforeEach(() => {
  window.localStorage.clear();
  wallet = new FakeWallet();
  rpc = new FakeRpc();
  api = new FakeApi(wallet.publicKey.toBase58());
  refresh = vi.fn<() => void>();
});
afterEach(cleanup);

describe('rejecting a submission when the reason cannot be stored', { timeout: 20_000 }, () => {
  it('says the reason was not saved, keeps the transaction final, and retries without the wallet', async () => {
    api.replies = [fails(new ApiError(0, 'NETWORK', 'unreachable')), stored(REASON)];
    await reject();

    const warning = await screen.findByRole('alert', {}, SLOW);
    expect(warning.textContent).toMatch(/recorded on-chain, but its reason text was not saved/);
    expect(warning.textContent).toMatch(/could not be reached/);
    // The transaction is shown for what it is: final. Its state is not rewritten.
    await waitFor(() => {
      expect(phase()).toBe('finalized');
    }, SLOW);
    expect(wallet.signedTransactions).toBe(1);
    expect(rpc.sent).toHaveLength(1);
    // The text is still on the page for the user to keep.
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Your reason/ }).value).toBe(
      REASON,
    );

    fireEvent.click(retryButton() as HTMLElement);
    await screen.findByText(/reason text is saved/, {}, SLOW);

    // The retry sent the same text for the same signature, and nothing to the wallet or the chain.
    expect(wallet.signedTransactions).toBe(1);
    expect(rpc.sent).toHaveLength(1);
    expect(api.reports).toEqual([
      { route: 'reject', signature: rpc.sent[0], reason: REASON },
      { route: 'reject', signature: rpc.sent[0], reason: REASON },
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(phase()).toBe('finalized');
  });

  it('does not take an answer without an error as proof that the reason was stored', async () => {
    // The API answers 200 with a task that shows no reason (it keeps the first text only).
    api.replies = [() => Promise.resolve(detail({ rejection: null }))];
    await reject();
    const warning = await screen.findByRole('alert', {}, SLOW);
    expect(warning.textContent).toMatch(/was not saved/);
    expect(warning.textContent).toMatch(/does not show this reason/);
    expect(screen.queryByText(/reason text is saved/)).toBeNull();
  });

  it('offers no retry when the API refuses the text itself', async () => {
    api.replies = [fails(new ApiError(422, 'REASON_MISMATCH', 'The reason does not match.'))];
    await reject();
    const warning = await screen.findByRole('alert', {}, SLOW);
    expect(warning.textContent).toMatch(/Taskra refused the reason: The reason does not match\./);
    expect(retryButton()).toBeNull();
    expect(wallet.signedTransactions).toBe(1);
  });

  it('sends one request however often retry is pressed', async () => {
    let release: (task: TaskDetail) => void = () => undefined;
    const pending: Reply = () => new Promise((resolve) => (release = resolve));
    api.replies = [fails(new ApiError(503, 'INTERNAL', 'down')), pending];
    await reject();
    await screen.findByRole('alert', {}, SLOW);

    const button = retryButton() as HTMLElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/Saving its reason text/);
    // While the request is in flight there is nothing to press.
    expect(retryButton()).toBeNull();
    expect(api.reports).toHaveLength(2);

    release(
      detail({ rejection: { reason: REASON, reasonHash: toHex(rejectionReasonHash(REASON)) } }),
    );
    await screen.findByText(/reason text is saved/, {}, SLOW);
    expect(api.reports).toHaveLength(2);
    expect(wallet.signedTransactions).toBe(1);
  });

  it('after the session expired, a retry signs a sign-in message and never a transaction', async () => {
    api.replies = [
      (): Promise<TaskDetail> => {
        api.current = null; // the server forgot the session
        return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in with your wallet.'));
      },
      stored(REASON),
    ];
    await reject();
    const warning = await screen.findByRole('alert', {}, SLOW);
    expect(warning.textContent).toMatch(/session ended/);
    expect(wallet.signedMessages).toHaveLength(1);

    // The page has noticed it is signed out before the retry is offered again.
    await screen.findByText(/Connected, not signed in/);
    fireEvent.click(retryButton() as HTMLElement);
    await screen.findByText(/reason text is saved/, {}, SLOW);
    expect(wallet.signedMessages).toHaveLength(2);
    expect(wallet.signedTransactions).toBe(1);
    expect(rpc.sent).toHaveLength(1);
  });

  it('warns before the page is left while the text exists only here', async () => {
    api.replies = [fails(new ApiError(0, 'NETWORK', 'unreachable')), stored(REASON)];
    await reject();
    await screen.findByRole('alert', {}, SLOW);
    const leaving = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leaving()).toBe(true);

    fireEvent.click(retryButton() as HTMLElement);
    await screen.findByText(/reason text is saved/, {}, SLOW);
    expect(leaving()).toBe(false);
  });
});

describe('a reason the server would refuse', () => {
  it('never reaches the wallet, the chain or the API', async () => {
    await reject('a'.repeat(REJECTION_REASON_MAX + 1));
    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toMatch(/too long/);
    expect(wallet.signedTransactions).toBe(0);
    expect(wallet.signedMessages).toHaveLength(0);
    expect(rpc.sent).toHaveLength(0);
    expect(api.reports).toHaveLength(0);
  });
});
