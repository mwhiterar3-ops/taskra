import { describe, expect, it } from 'vitest';
import { bytes32, makeTask } from './__fixtures__/fixtures.js';
import {
  currentSubmission,
  hasValidAttestation,
  matchesCurrentSubmission,
  nextSubmissionNonce,
} from './attestation.js';
import { TaskraSdkError } from './errors.js';

const X = bytes32(0x11);
const Y = bytes32(0x22);

const submitted = makeTask({ state: 'SUBMITTED', submissionNonce: 1n, evidenceHash: X });
const attested = makeTask({
  state: 'UNDER_REVIEW',
  submissionNonce: 1n,
  evidenceHash: X,
  attestedNonce: 1n,
  attestedHash: X,
  verifiedAt: 1_800_000_100n,
});

describe('submission nonce', () => {
  it('has no submission before the first submit_work', () => {
    const task = makeTask({ state: 'ACCEPTED' });
    expect(currentSubmission(task)).toBeNull();
    expect(nextSubmissionNonce(task)).toBe(1n);
  });

  it('reports the current submission and the next nonce', () => {
    expect(currentSubmission(submitted)).toEqual({ evidenceHash: X, submissionNonce: 1n });
    expect(nextSubmissionNonce(submitted)).toBe(2n);
  });

  it('stays exact for nonces beyond 2^53', () => {
    const task = makeTask({ submissionNonce: 9_007_199_254_740_993n, evidenceHash: X });
    expect(nextSubmissionNonce(task)).toBe(9_007_199_254_740_994n);
  });
});

describe('hasValidAttestation mirrors Task::has_valid_attestation', () => {
  it('is false with no attestation', () => {
    expect(hasValidAttestation(makeTask())).toBe(false);
    expect(hasValidAttestation(submitted)).toBe(false);
  });

  it('is true when hash, nonce and timestamp all match', () => {
    expect(hasValidAttestation(attested)).toBe(true);
  });

  it('is false when the nonce moved on, even for the same hash', () => {
    expect(hasValidAttestation({ ...attested, submissionNonce: 2n })).toBe(false);
  });

  it('is false when the hash changed', () => {
    expect(hasValidAttestation({ ...attested, evidenceHash: Y })).toBe(false);
  });

  it('is false when verified_at is zero', () => {
    expect(hasValidAttestation({ ...attested, verifiedAt: 0n })).toBe(false);
  });

  it('is false after a resubmission cleared the attestation', () => {
    const resubmitted = makeTask({
      state: 'SUBMITTED',
      submissionNonce: 2n,
      evidenceHash: Y,
      attestedNonce: 0n,
      attestedHash: bytes32(0),
      verifiedAt: 0n,
    });
    expect(hasValidAttestation(resubmitted)).toBe(false);
  });
});

describe('matchesCurrentSubmission', () => {
  it('matches only the exact hash and nonce', () => {
    expect(matchesCurrentSubmission(submitted, { evidenceHash: X, submissionNonce: 1n })).toBe(
      true,
    );
    expect(matchesCurrentSubmission(submitted, { evidenceHash: Y, submissionNonce: 1n })).toBe(
      false,
    );
    expect(matchesCurrentSubmission(submitted, { evidenceHash: X, submissionNonce: 0n })).toBe(
      false,
    );
    expect(matchesCurrentSubmission(submitted, { evidenceHash: X, submissionNonce: 2n })).toBe(
      false,
    );
  });

  it('never matches a task with no submission', () => {
    const task = makeTask({ state: 'ACCEPTED' });
    expect(matchesCurrentSubmission(task, { evidenceHash: bytes32(0), submissionNonce: 0n })).toBe(
      false,
    );
  });

  it('rejects malformed candidates', () => {
    expect(() =>
      matchesCurrentSubmission(submitted, {
        evidenceHash: new Uint8Array(31),
        submissionNonce: 1n,
      }),
    ).toThrow(TaskraSdkError);
    expect(() =>
      matchesCurrentSubmission(submitted, {
        evidenceHash: X,
        submissionNonce: 1 as unknown as bigint,
      }),
    ).toThrow(TaskraSdkError);
  });
});
