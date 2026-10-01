// Vectors are those exercised on-chain by programs/taskra/tests/client_lock.rs:
// the same three window profiles, the same 3-day work duration, the same
// acceptance time, and the same expected instants.

import { describe, expect, it } from 'vitest';
import { DAY, HOUR, makeTask, START } from './__fixtures__/fixtures.js';
import {
  computeTimeline,
  maxClientLockSeconds,
  type PlatformWindows,
  submissionWindows,
} from './timeline.js';

const WORK_DURATION = 3n * DAY;
const ACCEPTED_AT = START;
const WORK_DEADLINE = ACCEPTED_AT + WORK_DURATION;

const PROFILES: readonly (readonly [string, PlatformWindows, bigint])[] = [
  [
    'production',
    { reviewWindow: 48n * HOUR, verificationGrace: 24n * HOUR, disputeTimeout: 7n * DAY },
    WORK_DURATION + 11n * DAY,
  ],
  [
    'devnet-demo',
    { reviewWindow: 600n, verificationGrace: 300n, disputeTimeout: 900n },
    WORK_DURATION + 35n * 60n,
  ],
  [
    'grace-dominant',
    { reviewWindow: HOUR, verificationGrace: 5n * HOUR, disputeTimeout: 2n * HOUR },
    WORK_DURATION + 5n * HOUR + HOUR + 2n * HOUR,
  ],
];

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

describe('maxClientLockSeconds', () => {
  it.each(PROFILES)('%s', (_, windows, expected) => {
    expect(maxClientLockSeconds(WORK_DURATION, windows)).toBe(expected);
  });

  it('is work_duration + 11 days in production', () => {
    const [, production] = PROFILES[0] ?? [];
    if (production === undefined) throw new Error('missing profile');
    expect(maxClientLockSeconds(0n, production)).toBe(950_400n);
    expect(maxClientLockSeconds(WORK_DURATION, production)).toBe(1_209_600n);
  });
});

describe('worst-case junk path, as in client_lock.rs', () => {
  it.each(PROFILES)('%s', (_, windows, lock) => {
    const verificationDeadline = WORK_DEADLINE + windows.verificationGrace;

    // Junk submitted at the last valid second.
    const submitted = submissionWindows(WORK_DEADLINE, verificationDeadline, windows);
    const escalation = max(windows.reviewWindow, windows.verificationGrace);
    expect(submitted.disputeOpenAt).toBe(WORK_DEADLINE + escalation);
    expect(submitted.refundOpenAt).toBe(WORK_DEADLINE + escalation + windows.reviewWindow);

    // The developer escalates at the last valid second.
    const disputedAt = submitted.refundOpenAt;
    const task = makeTask({
      state: 'DISPUTED',
      acceptedAt: ACCEPTED_AT,
      workDuration: WORK_DURATION,
      workDeadline: WORK_DEADLINE,
      verificationDeadline,
      submissionNonce: 1n,
      submittedAt: WORK_DEADLINE,
      disputeOpenAt: submitted.disputeOpenAt,
      refundOpenAt: submitted.refundOpenAt,
      disputedAt,
      disputeDeadline: disputedAt + windows.disputeTimeout,
    });
    const timeline = computeTimeline(task, windows);

    expect(timeline.maxClientLockSeconds).toBe(lock);
    expect(timeline.disputeDeadline).toBe(ACCEPTED_AT + lock);
    // Funds are recoverable one second after the dispute deadline.
    expect(timeline.latestClientRecoveryAt).toBe(ACCEPTED_AT + lock + 1n);
    expect(timeline.latestClientRecoveryAt).toBe((timeline.disputeDeadline ?? 0n) + 1n);
  });
});

describe('submissionWindows', () => {
  const [, production] = PROFILES[0] ?? [];
  if (production === undefined) throw new Error('missing profile');
  const verificationDeadline = WORK_DEADLINE + production.verificationGrace;

  it('early submission: the verification deadline bounds the escalation', () => {
    const windows = submissionWindows(ACCEPTED_AT + HOUR, verificationDeadline, production);
    expect(windows.disputeOpenAt).toBe(verificationDeadline);
    expect(windows.refundOpenAt).toBe(WORK_DEADLINE + 24n * HOUR + 48n * HOUR);
  });

  it('late submission: a full review window after the submission', () => {
    const windows = submissionWindows(WORK_DEADLINE, verificationDeadline, production);
    expect(windows.disputeOpenAt).toBe(WORK_DEADLINE + 48n * HOUR);
    expect(windows.refundOpenAt).toBe(WORK_DEADLINE + 96n * HOUR);
  });

  it('never moves the refund past the documented bound', () => {
    const bound = WORK_DEADLINE + 96n * HOUR;
    for (let at = ACCEPTED_AT; at <= WORK_DEADLINE; at += WORK_DURATION / 7n) {
      expect(submissionWindows(at, verificationDeadline, production).refundOpenAt <= bound).toBe(
        true,
      );
    }
  });
});

describe('computeTimeline', () => {
  const [, production] = PROFILES[0] ?? [];
  if (production === undefined) throw new Error('missing profile');

  it('OPEN: nothing is scheduled and the client can still cancel', () => {
    expect(computeTimeline(makeTask(), production)).toEqual({
      workDeadline: null,
      verificationDeadline: null,
      reviewDeadline: null,
      developerDisputeWindow: null,
      clientRefundAfter: null,
      disputeDeadline: null,
      maxClientLockSeconds: WORK_DURATION + 11n * DAY,
      latestClientRecoveryAt: null,
    });
  });

  const accepted = {
    acceptedAt: ACCEPTED_AT,
    workDeadline: WORK_DEADLINE,
    verificationDeadline: WORK_DEADLINE + DAY,
  };

  it('ACCEPTED: the client may refund after the work deadline', () => {
    const timeline = computeTimeline(makeTask({ state: 'ACCEPTED', ...accepted }), production);
    expect(timeline.workDeadline).toBe(WORK_DEADLINE);
    expect(timeline.verificationDeadline).toBe(WORK_DEADLINE + DAY);
    expect(timeline.clientRefundAfter).toBe(WORK_DEADLINE);
    expect(timeline.developerDisputeWindow).toBeNull();
    expect(timeline.latestClientRecoveryAt).toBe(ACCEPTED_AT + WORK_DURATION + 11n * DAY + 1n);
  });

  const submission = {
    ...accepted,
    submissionNonce: 1n,
    submittedAt: ACCEPTED_AT + HOUR,
    disputeOpenAt: WORK_DEADLINE + DAY,
    refundOpenAt: WORK_DEADLINE + 3n * DAY,
  };

  it('SUBMITTED: developer window, then the client refund', () => {
    const timeline = computeTimeline(makeTask({ state: 'SUBMITTED', ...submission }), production);
    expect(timeline.developerDisputeWindow).toEqual({
      opensAfter: WORK_DEADLINE + DAY,
      closesAt: WORK_DEADLINE + 3n * DAY,
    });
    expect(timeline.clientRefundAfter).toBe(WORK_DEADLINE + 3n * DAY);
    expect(timeline.reviewDeadline).toBeNull();
  });

  it('UNDER_REVIEW: a review deadline and no client refund', () => {
    const task = makeTask({
      state: 'UNDER_REVIEW',
      ...submission,
      verifiedAt: ACCEPTED_AT + 2n * HOUR,
      reviewDeadline: ACCEPTED_AT + 50n * HOUR,
    });
    const timeline = computeTimeline(task, production);
    expect(timeline.reviewDeadline).toBe(ACCEPTED_AT + 50n * HOUR);
    expect(timeline.clientRefundAfter).toBeNull();
  });

  it('DISPUTED: a dispute deadline and no client refund', () => {
    const task = makeTask({
      state: 'DISPUTED',
      ...submission,
      disputedAt: ACCEPTED_AT + 3n * HOUR,
      disputeDeadline: ACCEPTED_AT + 3n * HOUR + 7n * DAY,
    });
    const timeline = computeTimeline(task, production);
    expect(timeline.disputeDeadline).toBe(ACCEPTED_AT + 3n * HOUR + 7n * DAY);
    expect(timeline.clientRefundAfter).toBeNull();
  });
});
