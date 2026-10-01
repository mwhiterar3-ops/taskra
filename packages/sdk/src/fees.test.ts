// The vectors are those of the Rust unit tests in programs/taskra/src/fees.rs.

import { describe, expect, it } from 'vitest';
import { TaskraSdkError } from './errors.js';
import { BPS_DENOMINATOR, computeFee, splitSettlement } from './fees.js';

const U64_MAX = 18_446_744_073_709_551_615n;

describe('computeFee', () => {
  it('takes two and a half percent of 100 USDC', () => {
    expect(computeFee(100_000_000n, 250)).toBe(2_500_000n);
  });

  it('floors fractional fees', () => {
    expect(computeFee(39n, 250)).toBe(0n);
    expect(computeFee(40n, 250)).toBe(1n);
    expect(computeFee(79n, 250)).toBe(1n);
    expect(computeFee(1n, 9_999)).toBe(0n);
  });

  it('handles rate extremes', () => {
    expect(computeFee(123_456n, 0)).toBe(0n);
    expect(computeFee(123_456n, 10_000)).toBe(123_456n);
  });

  it('does not overflow or lose precision at u64 max', () => {
    expect(computeFee(U64_MAX, 10_000)).toBe(U64_MAX);
    expect(computeFee(U64_MAX, 250)).toBe(U64_MAX / 40n);
    expect(computeFee(U64_MAX, 250)).toBe(461_168_601_842_738_790n);
  });

  it('never exceeds the amount for valid rates', () => {
    for (const amount of [0n, 1n, 39n, 40n, 41n, 9_999n, 10_000n, 10_001n, U64_MAX]) {
      for (const feeBps of [0, 1, 250, 9_999, 10_000]) {
        expect(computeFee(amount, feeBps) <= amount).toBe(true);
      }
    }
  });

  it('is exact above 2^53, where JavaScript numbers are not', () => {
    const amount = 9_007_199_254_740_993n; // 2^53 + 1
    expect(computeFee(amount, 250)).toBe(225_179_981_368_524n);
    expect(computeFee(amount, 250) * BPS_DENOMINATOR <= amount * 250n).toBe(true);
  });

  it.each([
    ['a number amount', 100, 250],
    ['a negative amount', -1n, 250],
    ['an amount above u64', U64_MAX + 1n, 250],
    ['a rate above 10000', 1n, 10_001],
    ['a negative rate', 1n, -1],
    ['a fractional rate', 1n, 2.5],
    ['a bigint rate', 1n, 250n],
    ['a NaN rate', 1n, Number.NaN],
  ])('rejects %s', (_, amount, feeBps) => {
    expect(() => computeFee(amount as bigint, feeBps as number)).toThrow(TaskraSdkError);
  });
});

describe('splitSettlement', () => {
  it('splits 100 USDC into 97.50 and 2.50', () => {
    expect(splitSettlement(100_000_000n, 250)).toEqual({
      fee: 2_500_000n,
      developerAmount: 97_500_000n,
    });
  });

  it('gives the developer everything when the fee floors to zero', () => {
    expect(splitSettlement(39n, 250)).toEqual({ fee: 0n, developerAmount: 39n });
    expect(splitSettlement(1n, 250)).toEqual({ fee: 0n, developerAmount: 1n });
    expect(splitSettlement(0n, 250)).toEqual({ fee: 0n, developerAmount: 0n });
  });

  it('always conserves the amount', () => {
    for (const amount of [1n, 39n, 40n, 12_345_677n, U64_MAX]) {
      const { fee, developerAmount } = splitSettlement(amount, 250);
      expect(fee + developerAmount).toBe(amount);
    }
  });
});
