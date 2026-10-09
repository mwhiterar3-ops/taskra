// The offered actions must be exactly those of docs/13-DECISIONS.md §2.6.

import { PublicKey } from '@solana/web3.js';
import type { TaskAccount, TaskState } from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { availableActions } from './actions';

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const CLIENT = key(1);
const DEVELOPER = key(2);
const AUTHORITY = key(3);
const STRANGER = key(4);
const HASH = new Uint8Array(32).fill(9);
const ZERO = new Uint8Array(32);

// W = 1000, V = 1100, D = 1200, R = 1400, RD = 1300, DD = 2000
function task(state: TaskState, patch: Partial<TaskAccount> = {}): TaskAccount {
  const accepted = state !== 'OPEN';
  const submitted = !['OPEN', 'ACCEPTED'].includes(state);
  return {
    taskId: new Uint8Array(16),
    client: CLIENT,
    developer: accepted ? DEVELOPER : null,
    amount: 100n,
    feeBps: 250,
    termsHash: HASH,
    state,
    outcome: 'NONE',
    workDuration: 900n,
    createdAt: 50n,
    acceptedAt: accepted ? 100n : 0n,
    workDeadline: accepted ? 1000n : 0n,
    verificationDeadline: accepted ? 1100n : 0n,
    submissionNonce: submitted ? 1n : 0n,
    evidenceHash: submitted ? HASH : ZERO,
    submittedAt: submitted ? 500n : 0n,
    disputeOpenAt: submitted ? 1200n : 0n,
    refundOpenAt: submitted ? 1400n : 0n,
    attestedNonce: 0n,
    attestedHash: ZERO,
    verifiedAt: 0n,
    reviewDeadline: state === 'UNDER_REVIEW' ? 1300n : 0n,
    disputedAt: state === 'DISPUTED' ? 1500n : 0n,
    disputeDeadline: state === 'DISPUTED' ? 2000n : 0n,
    rejectionReasonHash: ZERO,
    closedAt: 0n,
    bump: 255,
    escrowBump: 255,
    ...patch,
  };
}

function enabled(account: TaskAccount, wallet: PublicKey | null, chainTime: bigint): string[] {
  return availableActions({
    task: account,
    chainTime,
    wallet: wallet?.toBase58() ?? null,
    platformAuthority: AUTHORITY.toBase58(),
  })
    .filter((action) => action.enabled)
    .map((action) => action.kind);
}

describe('availableActions', () => {
  it('offers nothing without a connected wallet', () => {
    expect(enabled(task('OPEN'), null, 10n)).toEqual([]);
  });

  it('OPEN: the client may cancel; anyone else may accept', () => {
    expect(enabled(task('OPEN'), CLIENT, 10n)).toEqual(['cancel']);
    expect(enabled(task('OPEN'), STRANGER, 10n)).toEqual(['accept']);
  });

  it('ACCEPTED: submit until the work deadline, refund only after it', () => {
    expect(enabled(task('ACCEPTED'), DEVELOPER, 1000n)).toEqual(['submit']);
    expect(enabled(task('ACCEPTED'), DEVELOPER, 1001n)).toEqual([]);
    expect(enabled(task('ACCEPTED'), CLIENT, 1000n)).toEqual([]);
    expect(enabled(task('ACCEPTED'), CLIENT, 1001n)).toEqual(['refund']);
    expect(enabled(task('ACCEPTED'), STRANGER, 5000n)).toEqual([]);
  });

  it('SUBMITTED: the client may always approve, and refund only after the refund opens', () => {
    expect(enabled(task('SUBMITTED'), CLIENT, 600n)).toEqual(['approve']);
    expect(enabled(task('SUBMITTED'), CLIENT, 1400n)).toEqual(['approve']);
    expect(enabled(task('SUBMITTED'), CLIENT, 1401n)).toEqual(['approve', 'refund']);
  });

  it('SUBMITTED: the developer dispute window is (D, R], disjoint from the refund', () => {
    expect(enabled(task('SUBMITTED'), DEVELOPER, 1000n)).toEqual(['submit']);
    expect(enabled(task('SUBMITTED'), DEVELOPER, 1200n)).toEqual([]);
    expect(enabled(task('SUBMITTED'), DEVELOPER, 1201n)).toEqual(['developer_dispute']);
    expect(enabled(task('SUBMITTED'), DEVELOPER, 1400n)).toEqual(['developer_dispute']);
    expect(enabled(task('SUBMITTED'), DEVELOPER, 1401n)).toEqual([]);
  });

  it('UNDER_REVIEW: approve and reject until the review deadline, expiry by anyone after', () => {
    const review = task('UNDER_REVIEW');
    expect(enabled(review, CLIENT, 1300n)).toEqual(['approve', 'reject']);
    expect(enabled(review, CLIENT, 1301n)).toEqual(['expire_review']);
    expect(enabled(review, STRANGER, 1300n)).toEqual([]);
    expect(enabled(review, STRANGER, 1301n)).toEqual(['expire_review']);
    expect(enabled(review, DEVELOPER, 900n)).toEqual(['submit']);
    expect(enabled(review, DEVELOPER, 1301n)).toEqual(['expire_review']);
  });

  it('DISPUTED: the authority until the deadline, the fallback by anyone after', () => {
    const disputed = task('DISPUTED');
    expect(enabled(disputed, AUTHORITY, 2000n)).toEqual(['resolve_dispute']);
    expect(enabled(disputed, AUTHORITY, 2001n)).toEqual(['expire_dispute']);
    expect(enabled(disputed, CLIENT, 2000n)).toEqual([]);
    expect(enabled(disputed, DEVELOPER, 2001n)).toEqual(['expire_dispute']);
  });

  it('DISPUTED: says which way the fallback will go, from the attestation alone', () => {
    const note = (account: TaskAccount) =>
      availableActions({
        task: account,
        chainTime: 2001n,
        wallet: STRANGER.toBase58(),
        platformAuthority: AUTHORITY.toBase58(),
      })[0]?.note;
    expect(note(task('DISPUTED'))).toMatch(/Refunds the client/);
    expect(
      note(task('DISPUTED', { attestedNonce: 1n, attestedHash: HASH, verifiedAt: 1250n })),
    ).toMatch(/Pays the developer/);
  });

  it.each(['SETTLED', 'REFUNDED', 'CANCELLED'] as const)('%s: nothing, for anyone', (state) => {
    for (const wallet of [CLIENT, DEVELOPER, AUTHORITY, STRANGER]) {
      expect(enabled(task(state), wallet, 9999n)).toEqual([]);
    }
  });

  it('never offers two different fund outcomes to different parties at the same moment', () => {
    const PAYS = ['approve', 'expire_review'];
    const REFUNDS = ['cancel', 'refund'];
    for (const state of ['OPEN', 'ACCEPTED', 'SUBMITTED', 'UNDER_REVIEW'] as const) {
      for (let now = 0n; now <= 2200n; now += 50n) {
        const client = enabled(task(state), CLIENT, now);
        const others = [
          ...enabled(task(state), DEVELOPER, now),
          ...enabled(task(state), STRANGER, now),
        ];
        const clientCanRefund = client.some((kind) => REFUNDS.includes(kind));
        const otherCanPay = others.some((kind) => PAYS.includes(kind));
        expect(clientCanRefund && otherCanPay, `${state} at ${now.toString()}`).toBe(false);
      }
    }
  });
});
