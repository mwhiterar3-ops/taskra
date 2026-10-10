import { describe, expect, it } from 'vitest';
import { toHex } from './bytes.js';
import { TaskraSdkError } from './errors.js';
import { evidenceTrailers, rejectionReasonHash, termsHash, termsMatchTask } from './hashes.js';

describe('evidenceTrailers', () => {
  const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  it('names the task (lower-cased) and the wallet (as given) on two lines', () => {
    expect(evidenceTrailers('123E4567-e89b-12d3-a456-426614174000', WALLET)).toBe(
      `Taskra-Task: 123e4567-e89b-12d3-a456-426614174000\nTaskra-Developer: ${WALLET}`,
    );
  });
  it('refuses anything that is not a task UUID and a wallet address', () => {
    expect(() => evidenceTrailers('not-a-uuid', WALLET)).toThrow(TaskraSdkError);
    expect(() => evidenceTrailers('123e4567-e89b-12d3-a456-426614174000', 'x\ny')).toThrow(
      TaskraSdkError,
    );
  });
});

describe('termsMatchTask', () => {
  const metadata = {
    repo: 'octo-org/parser',
    acceptanceCriteria: 'Parses transaction signatures\nReturns structured output',
    workDuration: 172_800n,
    amount: 100_000_000n,
  };
  const task = { termsHash: termsHash(metadata), amount: 100_000_000n, workDuration: 172_800n };

  it('accepts metadata that hashes to the on-chain terms', () => {
    expect(termsMatchTask(metadata, task)).toBe(true);
    expect(termsMatchTask({ ...metadata, repo: 'Octo-Org/Parser' }, task)).toBe(true);
  });

  it.each([
    ['a different repository', { repo: 'octo-org/other' }],
    ['edited acceptance criteria', { acceptanceCriteria: 'Anything goes' }],
    ['a different amount', { amount: 1n }],
    ['a different duration', { workDuration: 1n }],
    ['an unusable repository', { repo: 'https://github.com/octo-org/parser' }],
  ])('rejects %s', (_, patch) => {
    expect(termsMatchTask({ ...metadata, ...patch }, task)).toBe(false);
  });

  it('rejects a task whose recorded amount differs from the hashed one', () => {
    expect(termsMatchTask(metadata, { ...task, amount: 5n })).toBe(false);
  });
});

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
