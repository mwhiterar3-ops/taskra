import { rejectionReasonHash } from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { REJECTION_REASON_MAX, rejectionReasonProblem } from './rejection';

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
