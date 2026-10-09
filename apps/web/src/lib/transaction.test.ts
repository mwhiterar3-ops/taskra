// @vitest-environment node
import { PublicKey } from '@solana/web3.js';
import { acceptTask, createTaskraConfig } from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { FakeRpc, FakeWallet } from '../testing/fakes';
import { classifyFailure, runTransaction, type TxState } from './transaction';
import { toWalletError, WalletError } from './wallet';

const config = createTaskraConfig({
  cluster: 'localnet',
  usdcMint: new PublicKey(new Uint8Array(32).fill(7)),
});
const task = new PublicKey(new Uint8Array(32).fill(8));

async function run(rpc: FakeRpc, wallet: FakeWallet, onConfirmed?: (s: string) => Promise<void>) {
  const states: TxState[] = [];
  const final = await runTransaction({
    rpc,
    wallet,
    feePayer: wallet.publicKey,
    instructions: [acceptTask(config, { developer: wallet.publicKey, task })],
    onState: (state) => states.push(state),
    ...(onConfirmed === undefined ? {} : { onConfirmed }),
    pollMs: 1,
  });
  return { states, final, phases: states.map((state) => state.phase) };
}

const confirmed = { err: null, confirmationStatus: 'confirmed' };
const finalized = { err: null, confirmationStatus: 'finalized' };

describe('runTransaction', () => {
  it('walks building -> awaiting signature -> submitted -> confirmed -> finalized', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [
      null,
      { err: null, confirmationStatus: 'processed' },
      confirmed,
      confirmed,
      finalized,
    ];
    const reported: string[] = [];
    const { phases, final } = await run(rpc, new FakeWallet(), (signature) => {
      reported.push(signature);
      return Promise.resolve();
    });
    expect(phases).toEqual([
      'building',
      'awaiting_signature',
      'submitted',
      'confirmed',
      'finalized',
    ]);
    expect(final).toEqual({ phase: 'finalized', signature: rpc.sent[0] });
    // Reported once, at confirmation, with the signature that was actually sent.
    expect(reported).toEqual([rpc.sent[0]]);
  });

  it('distinguishes confirmed from finalized: confirmed alone is never the final state', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [confirmed, confirmed, confirmed, finalized];
    const { states } = await run(rpc, new FakeWallet());
    const confirmedIndex = states.findIndex((state) => state.phase === 'confirmed');
    const finalizedIndex = states.findIndex((state) => state.phase === 'finalized');
    expect(confirmedIndex).toBeGreaterThan(-1);
    expect(finalizedIndex).toBeGreaterThan(confirmedIndex);
    expect(states.filter((state) => state.phase === 'confirmed')).toHaveLength(1);
  });

  it('reports a wallet rejection as rejected, and sends nothing', async () => {
    const rpc = new FakeRpc();
    const wallet = new FakeWallet();
    wallet.onSign = 'reject';
    const { phases, final } = await run(rpc, wallet);
    expect(phases).toEqual(['building', 'awaiting_signature', 'failed']);
    expect(final).toMatchObject({
      phase: 'failed',
      signature: null,
      failure: { kind: 'rejected' },
    });
    expect(rpc.sent).toEqual([]);
  });

  it('reports insufficient funds from preflight', async () => {
    const rpc = new FakeRpc();
    rpc.sendError = Object.assign(new Error('Transaction simulation failed'), {
      logs: ['Program log: Error: insufficient funds', 'failed: custom program error: 0x1'],
    });
    const { final, phases } = await run(rpc, new FakeWallet());
    expect(phases.at(-1)).toBe('failed');
    expect(final).toMatchObject({ failure: { kind: 'insufficient_funds' }, signature: null });
  });

  it('decodes a program error from preflight into its name and a plain message', async () => {
    const rpc = new FakeRpc();
    rpc.sendError = new Error('failed: custom program error: 0x1778');
    const { final } = await run(rpc, new FakeWallet());
    expect(final).toMatchObject({
      phase: 'failed',
      failure: {
        kind: 'program',
        code: 'InvalidState',
        message: 'The task is no longer in a state that allows this.',
      },
    });
  });

  it('reports a transaction that executed and failed, never as success', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [
      null,
      { err: { InstructionError: [0, { Custom: 6012 }] }, confirmationStatus: 'confirmed' },
    ];
    let reported = 0;
    const { phases, final } = await run(rpc, new FakeWallet(), () => {
      reported += 1;
      return Promise.resolve();
    });
    expect(phases).toEqual(['building', 'awaiting_signature', 'submitted', 'failed']);
    expect(final).toMatchObject({ failure: { kind: 'program', code: 'EvidenceMismatch' } });
    expect(final).toMatchObject({ signature: rpc.sent[0] });
    expect(reported).toBe(0);
  });

  it('reports an expired transaction once its blockhash can no longer land', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [null];
    rpc.blockHeight = 151;
    const { final, phases } = await run(rpc, new FakeWallet());
    expect(phases).toEqual(['building', 'awaiting_signature', 'submitted', 'failed']);
    expect(final).toMatchObject({ failure: { kind: 'expired' } });
  });

  it('survives a few failed status polls', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [new Error('fetch failed'), new Error('fetch failed'), confirmed, finalized];
    expect((await run(rpc, new FakeWallet())).final.phase).toBe('finalized');
  });

  it('gives up as a network failure, without claiming an outcome, when polling keeps failing', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [new Error('fetch failed')];
    const { final } = await run(rpc, new FakeWallet());
    expect(final).toMatchObject({ phase: 'failed', failure: { kind: 'network' } });
    expect(final).toMatchObject({ signature: rpc.sent[0] });
  });

  it('reports an unreachable RPC endpoint before anything is signed', async () => {
    const rpc = new FakeRpc();
    rpc.getLatestBlockhash = () => Promise.reject(new TypeError('fetch failed'));
    const wallet = new FakeWallet();
    const { phases, final } = await run(rpc, wallet);
    expect(phases).toEqual(['building', 'failed']);
    expect(final).toMatchObject({ failure: { kind: 'network' } });
    expect(wallet.signedTransactions).toBe(0);
  });

  it('still reaches finality when reporting to the API fails', async () => {
    const rpc = new FakeRpc();
    rpc.statuses = [confirmed, finalized];
    const { final } = await run(rpc, new FakeWallet(), () => Promise.reject(new Error('API down')));
    expect(final.phase).toBe('finalized');
  });
});

describe('classifying failures', () => {
  it('recognises how different wallets say no', () => {
    expect(toWalletError({ code: 4001, message: 'x' }, 'the transaction').kind).toBe('rejected');
    expect(toWalletError(new Error('User rejected the request.'), 'the transaction').kind).toBe(
      'rejected',
    );
    expect(toWalletError(new Error('Ledger device locked'), 'the transaction').kind).toBe('failed');
    const original = new WalletError('rejected', 'kept');
    expect(toWalletError(original, 'anything')).toBe(original);
  });

  it('maps unknown errors to a network failure rather than inventing a cause', () => {
    expect(classifyFailure(new Error('socket hang up')).kind).toBe('network');
    expect(classifyFailure(new Error('Blockhash not found')).kind).toBe('expired');
    expect(classifyFailure(new WalletError('failed', 'broken')).kind).toBe('wallet');
  });
});
