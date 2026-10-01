// Pure time arithmetic for a task (docs/13-DECISIONS.md §2.2 and §2.7).
// All values are unix seconds as bigint. "After X" means `now > X`; "until X"
// means `now <= X`, matching the program's boundary convention.

import type { PlatformAccount, TaskAccount } from './accounts.js';
import { requireI64 } from './bytes.js';

export type PlatformWindows = Pick<
  PlatformAccount,
  'reviewWindow' | 'verificationGrace' | 'disputeTimeout'
>;

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

/**
 * The longest time after acceptance during which a client cannot recover
 * escrow when the developer never earns payment:
 * `work_duration + max(review_window, verification_grace) + review_window + dispute_timeout`.
 */
export function maxClientLockSeconds(workDuration: bigint, windows: PlatformWindows): bigint {
  return (
    requireI64(workDuration, 'workDuration') +
    max(windows.reviewWindow, windows.verificationGrace) +
    windows.reviewWindow +
    windows.disputeTimeout
  );
}

export interface SubmissionWindows {
  /** The developer may open a dispute after this time... */
  readonly disputeOpenAt: bigint;
  /** ...until this time, after which the client may refund instead. */
  readonly refundOpenAt: bigint;
}

/** The windows `submit_work` records for a submission made at `submittedAt`. */
export function submissionWindows(
  submittedAt: bigint,
  verificationDeadline: bigint,
  windows: PlatformWindows,
): SubmissionWindows {
  const disputeOpenAt = max(submittedAt + windows.reviewWindow, verificationDeadline);
  return { disputeOpenAt, refundOpenAt: disputeOpenAt + windows.reviewWindow };
}

export interface TaskTimeline {
  /** `submit_work` is valid until this time. `null` before acceptance. */
  readonly workDeadline: bigint | null;
  /** `record_attestation` is valid until this time. `null` before acceptance. */
  readonly verificationDeadline: bigint | null;
  /** `approve_task` and `reject_task` are valid until this time; `expire_review` after it. */
  readonly reviewDeadline: bigint | null;
  /** `open_developer_dispute` is valid after `opensAfter` and until `closesAt`. */
  readonly developerDisputeWindow: {
    readonly opensAfter: bigint;
    readonly closesAt: bigint;
  } | null;
  /** `refund_expired` is valid after this time, in the task's current state. */
  readonly clientRefundAfter: bigint | null;
  /** `resolve_dispute` is valid until this time; `expire_dispute` after it. */
  readonly disputeDeadline: bigint | null;
  /** See `maxClientLockSeconds`. */
  readonly maxClientLockSeconds: bigint;
  /**
   * The first second at which the client's funds are recoverable in the worst
   * case: `accepted_at + maxClientLockSeconds + 1`. `null` before acceptance,
   * when the client can still cancel.
   */
  readonly latestClientRecoveryAt: bigint | null;
}

function set(value: bigint): bigint | null {
  return value === 0n ? null : value;
}

/** Describes when each time-bound instruction is valid for this task. */
export function computeTimeline(task: TaskAccount, platform: PlatformWindows): TaskTimeline {
  const maxLock = maxClientLockSeconds(task.workDuration, platform);
  const submitted = task.submissionNonce !== 0n;

  let clientRefundAfter: bigint | null = null;
  if (task.state === 'ACCEPTED') clientRefundAfter = task.workDeadline;
  if (task.state === 'SUBMITTED') clientRefundAfter = task.refundOpenAt;

  return {
    workDeadline: set(task.workDeadline),
    verificationDeadline: set(task.verificationDeadline),
    reviewDeadline: set(task.reviewDeadline),
    developerDisputeWindow: submitted
      ? { opensAfter: task.disputeOpenAt, closesAt: task.refundOpenAt }
      : null,
    clientRefundAfter,
    disputeDeadline: set(task.disputeDeadline),
    maxClientLockSeconds: maxLock,
    latestClientRecoveryAt: task.acceptedAt === 0n ? null : task.acceptedAt + maxLock + 1n,
  };
}
