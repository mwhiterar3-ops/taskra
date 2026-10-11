import { rejectionReasonHash, toHex } from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { ApiError, type TaskDetail } from './api';
import {
  hasUnpublishedRejection,
  REJECTION_REASON_MAX,
  rejectionReasonProblem,
  saveRejectionReason,
} from './rejection';

const MAX = REJECTION_REASON_MAX;

describe('rejectionReasonProblem', () => {
  it('accepts an ordinary reason', () => {
    expect(rejectionReasonProblem('The parser drops the last instruction.')).toBeNull();
  });

  it('refuses a reason that is empty once trimmed', () => {
    for (const reason of ['', '   ', '\n\t ']) {
      expect(rejectionReasonProblem(reason)).toMatch(/Give a reason/);
    }
  });

  it('accepts exactly the limit and refuses one more', () => {
    expect(rejectionReasonProblem('a'.repeat(MAX))).toBeNull();
    expect(rejectionReasonProblem('a'.repeat(MAX + 1))).toMatch(/too long/);
  });

  // The API counts what is sent, so padding counts even though it is not stored.
  it('counts surrounding whitespace, as the API does', () => {
    expect(rejectionReasonProblem(` ${'a'.repeat(MAX)}`)).toMatch(/too long/);
    expect(rejectionReasonProblem(` ${'a'.repeat(MAX - 1)}`)).toBeNull();
  });

  // The API counts UTF-16 code units: an emoji is two.
  it('counts code units, not visible characters', () => {
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2);
    expect(rejectionReasonProblem(emoji.repeat(MAX / 2))).toBeNull();
    expect(rejectionReasonProblem(emoji.repeat(MAX / 2 + 1))).toMatch(/too long/);
  });

  // The database counts the stored, normalized text. U+0958 normalizes to two
  // characters, so a text within the API's limit can exceed the database's.
  it('refuses a text that grows past the limit when normalized', () => {
    const expanding = 'क़';
    expect(expanding.normalize('NFC')).toHaveLength(2);
    const reason = expanding.repeat(MAX / 2 + 1);
    expect(reason.length).toBeLessThanOrEqual(MAX);
    expect(rejectionReasonProblem(reason)).toMatch(/too long/);
    expect(rejectionReasonProblem(expanding.repeat(MAX / 2))).toBeNull();
  });

  it('never accepts a text the hash function would refuse', () => {
    for (const reason of ['x', 'a'.repeat(MAX), '  padded  ', 'café']) {
      expect(rejectionReasonProblem(reason)).toBeNull();
      expect(() => rejectionReasonHash(reason)).not.toThrow();
    }
  });
});

describe('saveRejectionReason', () => {
  const REASON = 'Not what was asked for.';
  const shows = (rejection: TaskDetail['rejection']) => ({ rejection }) as TaskDetail;
  const save = (report: () => Promise<TaskDetail>) =>
    saveRejectionReason({ report }, 'task', 'signature', REASON);

  it('is saved only when the answer shows this text', async () => {
    const reasonHash = toHex(rejectionReasonHash(REASON));
    expect(await save(() => Promise.resolve(shows({ reason: REASON, reasonHash })))).toEqual({
      saved: true,
    });
    // Padding and normalization do not change what is stored, so they do not change the hash.
    expect(
      await saveRejectionReason(
        { report: () => Promise.resolve(shows({ reason: REASON, reasonHash })) },
        'task',
        'signature',
        `  ${REASON}\n`,
      ),
    ).toEqual({ saved: true });
  });

  it('is not saved when the API answers without showing it, or shows another text', async () => {
    for (const rejection of [null, { reason: 'other', reasonHash: 'ab'.repeat(32) }]) {
      expect(await save(() => Promise.resolve(shows(rejection)))).toMatchObject({
        saved: false,
        retryable: true,
      });
    }
  });

  it('can be retried after an outage, a lost session or a transaction not seen yet', async () => {
    const cases: [ApiError | Error, boolean][] = [
      [new ApiError(0, 'NETWORK', 'x'), false],
      [new ApiError(401, 'UNAUTHENTICATED', 'x'), true],
      [new ApiError(404, 'TRANSACTION_NOT_FOUND', 'x'), false],
      [new ApiError(429, 'RATE_LIMITED', 'x'), false],
      [new ApiError(500, 'INTERNAL', 'x'), false],
      [new Error('anything else'), false],
    ];
    for (const [error, sessionExpired] of cases) {
      expect(await save(() => Promise.reject(error))).toMatchObject({
        saved: false,
        retryable: true,
        sessionExpired,
      });
    }
  });

  it('cannot be retried when the API refuses the text or the caller', async () => {
    for (const error of [
      new ApiError(400, 'VALIDATION_ERROR', 'x'),
      new ApiError(403, 'FORBIDDEN', 'x'),
      new ApiError(404, 'NOT_FOUND', 'x'),
      new ApiError(422, 'REASON_MISMATCH', 'x'),
    ]) {
      expect(await save(() => Promise.reject(error))).toMatchObject({
        saved: false,
        retryable: false,
      });
    }
  });
});

describe('hasUnpublishedRejection', () => {
  const hash = new Uint8Array(32).fill(7);
  const none = new Uint8Array(32);

  it('is true only for a recorded rejection whose text the API does not hold', () => {
    const rejected = { disputedAt: 1500n, rejectionReasonHash: hash };
    expect(hasUnpublishedRejection(rejected, { rejection: null })).toBe(true);
    expect(hasUnpublishedRejection(rejected, { rejection: { reason: 'r', reasonHash: 'h' } })).toBe(
      false,
    );
    // A dispute the developer opened records no reason.
    expect(
      hasUnpublishedRejection(
        { disputedAt: 1500n, rejectionReasonHash: none },
        { rejection: null },
      ),
    ).toBe(false);
    expect(
      hasUnpublishedRejection({ disputedAt: 0n, rejectionReasonHash: none }, { rejection: null }),
    ).toBe(false);
    expect(hasUnpublishedRejection(null, { rejection: null })).toBe(false);
  });
});
