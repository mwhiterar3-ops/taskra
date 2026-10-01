// Facts about a task's submission and attestation. These helpers describe
// what is recorded on-chain; they authorize nothing. Only the program decides.

import type { TaskAccount } from './accounts.js';
import { bytesEqual, requireBytes, requireU64 } from './bytes.js';

export interface Submission {
  readonly evidenceHash: Uint8Array;
  readonly submissionNonce: bigint;
}

/** The submission currently recorded on the task, or `null` before the first one. */
export function currentSubmission(task: TaskAccount): Submission | null {
  if (task.submissionNonce === 0n) return null;
  return { evidenceHash: task.evidenceHash, submissionNonce: task.submissionNonce };
}

/** The nonce the task will carry after its next `submit_work`. */
export function nextSubmissionNonce(task: TaskAccount): bigint {
  return task.submissionNonce + 1n;
}

/**
 * Mirrors `Task::has_valid_attestation`: a VERIFIED attestation exists for the
 * task's current evidence hash and submission nonce.
 */
export function hasValidAttestation(task: TaskAccount): boolean {
  return (
    task.verifiedAt !== 0n &&
    task.attestedNonce === task.submissionNonce &&
    bytesEqual(task.attestedHash, task.evidenceHash)
  );
}

/**
 * Whether `(evidenceHash, submissionNonce)` names the task's current
 * submission, i.e. whether `record_attestation` with these arguments would
 * pass the program's hash and nonce checks. It says nothing about the state,
 * the deadline or the signer.
 */
export function matchesCurrentSubmission(task: TaskAccount, candidate: Submission): boolean {
  requireBytes(candidate.evidenceHash, 32, 'evidenceHash');
  requireU64(candidate.submissionNonce, 'submissionNonce');
  return (
    task.submissionNonce !== 0n &&
    candidate.submissionNonce === task.submissionNonce &&
    bytesEqual(candidate.evidenceHash, task.evidenceHash)
  );
}
