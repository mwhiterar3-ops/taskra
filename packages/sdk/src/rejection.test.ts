import { describe, expect, it } from 'vitest';
import { toHex } from './bytes.js';
import { TaskraSdkError } from './errors.js';
import { rejectionReasonHash } from './hashes.js';

describe('rejectionReasonHash', () => {
  it('is plain SHA-256 of the text (FIPS 180-2 vector "abc")', () => {
    expect(toHex(rejectionReasonHash('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalizes to NFC and trims before hashing', () => {
    const composed = rejectionReasonHash('Café is missing tests');
    expect(rejectionReasonHash('  Café is missing tests\n')).toEqual(composed);
  });

  it('never yields the zero hash the program refuses, and rejects empty text', () => {
    expect(rejectionReasonHash('x').some((byte) => byte !== 0)).toBe(true);
    expect(() => rejectionReasonHash('   ')).toThrow(TaskraSdkError);
  });
});
