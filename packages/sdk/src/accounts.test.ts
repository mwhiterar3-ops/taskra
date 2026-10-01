import { describe, expect, it } from 'vitest';
import {
  ATTESTER,
  AUTHORITY,
  bytes32,
  CLIENT,
  concat,
  DEVELOPER,
  discriminator,
  i64le,
  MINT,
  TREASURY,
  u16le,
  u64le,
} from './__fixtures__/fixtures.js';
import { decodePlatform, decodeTask, type PlatformAccount, type TaskAccount } from './accounts.js';
import { TaskraSdkError } from './errors.js';
import { IDL } from './generated/idl.js';
import { SYSTEM_PROGRAM_ID } from './idl.js';

const U64_MAX = (1n << 64n) - 1n;
const TASK_ID = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

// The byte layout below is written out by hand, field by field, in the order
// of programs/taskra/src/state.rs.
function taskBytes(overrides: { developer?: Uint8Array; state?: number; outcome?: number } = {}) {
  return concat(
    discriminator('account', 'Task'),
    TASK_ID, // task_id
    CLIENT.toBytes(), // client
    overrides.developer ?? DEVELOPER.toBytes(), // developer
    u64le(U64_MAX), // amount
    u16le(250), // fee_bps
    bytes32(0x71), // terms_hash
    Uint8Array.of(overrides.state ?? 3), // state: UnderReview
    Uint8Array.of(overrides.outcome ?? 0), // outcome: None
    i64le(259_200n), // work_duration
    i64le(1_800_000_000n), // created_at
    i64le(1_800_000_001n), // accepted_at
    i64le(1_800_259_201n), // work_deadline
    i64le(1_800_345_601n), // verification_deadline
    u64le(9_007_199_254_740_993n), // submission_nonce: 2^53 + 1
    bytes32(0xe1), // evidence_hash
    i64le(1_800_000_002n), // submitted_at
    i64le(1_800_345_601n), // dispute_open_at
    i64le(1_800_518_401n), // refund_open_at
    u64le(9_007_199_254_740_993n), // attested_nonce
    bytes32(0xe1), // attested_hash
    i64le(1_800_000_003n), // verified_at
    i64le(1_800_172_803n), // review_deadline
    i64le(0n), // disputed_at
    i64le(0n), // dispute_deadline
    bytes32(0), // rejection_reason_hash
    i64le(0n), // closed_at
    Uint8Array.of(254), // bump
    Uint8Array.of(255), // escrow_bump
  );
}

describe('decodeTask', () => {
  it('decodes every field with full precision', () => {
    const task = decodeTask(taskBytes());
    expect(task.taskId).toEqual(TASK_ID);
    expect(task.client.equals(CLIENT)).toBe(true);
    expect(task.developer?.equals(DEVELOPER)).toBe(true);
    expect(task.amount).toBe(18_446_744_073_709_551_615n);
    expect(task.feeBps).toBe(250);
    expect(task.termsHash).toEqual(bytes32(0x71));
    expect(task.state).toBe('UNDER_REVIEW');
    expect(task.outcome).toBe('NONE');
    expect(task.workDuration).toBe(259_200n);
    expect(task.createdAt).toBe(1_800_000_000n);
    expect(task.acceptedAt).toBe(1_800_000_001n);
    expect(task.workDeadline).toBe(1_800_259_201n);
    expect(task.verificationDeadline).toBe(1_800_345_601n);
    // Not representable as a JavaScript number without rounding.
    expect(task.submissionNonce).toBe(9_007_199_254_740_993n);
    expect(task.evidenceHash).toEqual(bytes32(0xe1));
    expect(task.submittedAt).toBe(1_800_000_002n);
    expect(task.disputeOpenAt).toBe(1_800_345_601n);
    expect(task.refundOpenAt).toBe(1_800_518_401n);
    expect(task.attestedNonce).toBe(9_007_199_254_740_993n);
    expect(task.attestedHash).toEqual(bytes32(0xe1));
    expect(task.verifiedAt).toBe(1_800_000_003n);
    expect(task.reviewDeadline).toBe(1_800_172_803n);
    expect(task.disputedAt).toBe(0n);
    expect(task.disputeDeadline).toBe(0n);
    expect(task.rejectionReasonHash).toEqual(bytes32(0));
    expect(task.closedAt).toBe(0n);
    expect(task.bump).toBe(254);
    expect(task.escrowBump).toBe(255);
  });

  it('returns bigint for every 64-bit field and never a number', () => {
    const task = decodeTask(taskBytes());
    const definition = IDL.types.find((type) => type.name === 'Task');
    const wide = (definition?.type.fields ?? [])
      .filter((field) => field.type === 'u64' || field.type === 'i64')
      .map((field) => field.name.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    expect(wide).toHaveLength(16);
    for (const name of wide) {
      expect(typeof (task as unknown as Record<string, unknown>)[name], name).toBe('bigint');
    }
  });

  it('reports no developer before acceptance', () => {
    const task = decodeTask(taskBytes({ developer: SYSTEM_PROGRAM_ID.toBytes(), state: 0 }));
    expect(task.developer).toBeNull();
    expect(task.state).toBe('OPEN');
  });

  it('maps every state and outcome byte', () => {
    const states = [
      'OPEN',
      'ACCEPTED',
      'SUBMITTED',
      'UNDER_REVIEW',
      'DISPUTED',
      'SETTLED',
      'REFUNDED',
      'CANCELLED',
    ];
    states.forEach((state, index) => {
      expect(decodeTask(taskBytes({ state: index })).state).toBe(state);
    });
    const outcomes = [
      'NONE',
      'CANCELLED',
      'APPROVED',
      'REVIEW_EXPIRED',
      'WORK_DEADLINE_MISSED',
      'NEVER_VERIFIED',
      'DISPUTE_RESOLVED_FOR_DEVELOPER',
      'DISPUTE_RESOLVED_FOR_CLIENT',
      'DISPUTE_EXPIRED_FOR_DEVELOPER',
      'DISPUTE_EXPIRED_FOR_CLIENT',
    ];
    outcomes.forEach((outcome, index) => {
      expect(decodeTask(taskBytes({ outcome: index })).outcome).toBe(outcome);
    });
  });

  it('has exactly the fields of the TaskAccount interface', () => {
    const expected = [
      'taskId',
      'client',
      'developer',
      'amount',
      'feeBps',
      'termsHash',
      'state',
      'outcome',
      'workDuration',
      'createdAt',
      'acceptedAt',
      'workDeadline',
      'verificationDeadline',
      'submissionNonce',
      'evidenceHash',
      'submittedAt',
      'disputeOpenAt',
      'refundOpenAt',
      'attestedNonce',
      'attestedHash',
      'verifiedAt',
      'reviewDeadline',
      'disputedAt',
      'disputeDeadline',
      'rejectionReasonHash',
      'closedAt',
      'bump',
      'escrowBump',
    ] as const satisfies readonly (keyof TaskAccount)[];
    // Fails to compile if the interface gains a key that is not listed above.
    const exhaustive: Exclude<keyof TaskAccount, (typeof expected)[number]> extends never
      ? true
      : false = true;
    expect(exhaustive).toBe(true);
    expect(Object.keys(decodeTask(taskBytes()))).toEqual([...expected]);
  });

  it.each([
    ['an invalid state byte', taskBytes({ state: 8 })],
    ['an invalid outcome byte', taskBytes({ outcome: 10 })],
    ['truncated data', taskBytes().slice(0, -1)],
    ['trailing data', concat(taskBytes(), Uint8Array.of(0))],
    ['an empty buffer', new Uint8Array(0)],
    [
      'a Platform discriminator',
      concat(discriminator('account', 'Platform'), taskBytes().slice(8)),
    ],
    ['zeroed data', new Uint8Array(taskBytes().length)],
  ])('rejects %s', (_, data) => {
    expect(() => decodeTask(data)).toThrow(TaskraSdkError);
  });
});

describe('decodePlatform', () => {
  const platformBytes = concat(
    discriminator('account', 'Platform'),
    AUTHORITY.toBytes(),
    ATTESTER.toBytes(),
    TREASURY.toBytes(),
    MINT.toBytes(),
    u16le(250),
    i64le(172_800n),
    i64le(86_400n),
    i64le(604_800n),
    Uint8Array.of(255),
  );

  it('decodes every field', () => {
    const platform = decodePlatform(platformBytes);
    expect(platform.authority.equals(AUTHORITY)).toBe(true);
    expect(platform.attester.equals(ATTESTER)).toBe(true);
    expect(platform.treasury.equals(TREASURY)).toBe(true);
    expect(platform.usdcMint.equals(MINT)).toBe(true);
    expect(platform.feeBps).toBe(250);
    expect(platform.reviewWindow).toBe(172_800n);
    expect(platform.verificationGrace).toBe(86_400n);
    expect(platform.disputeTimeout).toBe(604_800n);
    expect(platform.bump).toBe(255);
  });

  it('has exactly the fields of the PlatformAccount interface', () => {
    const expected = [
      'authority',
      'attester',
      'treasury',
      'usdcMint',
      'feeBps',
      'reviewWindow',
      'verificationGrace',
      'disputeTimeout',
      'bump',
    ] as const satisfies readonly (keyof PlatformAccount)[];
    const exhaustive: Exclude<keyof PlatformAccount, (typeof expected)[number]> extends never
      ? true
      : false = true;
    expect(exhaustive).toBe(true);
    expect(Object.keys(decodePlatform(platformBytes))).toEqual([...expected]);
  });

  it('rejects a Task account and malformed data', () => {
    expect(() => decodePlatform(taskBytes())).toThrow(TaskraSdkError);
    expect(() => decodePlatform(platformBytes.slice(0, 20))).toThrow(TaskraSdkError);
    expect(() => decodePlatform(concat(platformBytes, Uint8Array.of(1)))).toThrow(TaskraSdkError);
  });
});
