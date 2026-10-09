import { describe, expect, it } from 'vitest';
import { formatDuration, formatUsdc, parseHours, parseUsdc, shortAddress } from './amounts';

describe('parseUsdc', () => {
  it.each([
    ['100', 100_000_000n],
    ['100.5', 100_500_000n],
    ['97.50', 97_500_000n],
    ['0.000001', 1n],
    [' 49.99 ', 49_990_000n],
  ])('parses %s exactly', (text, expected) => {
    expect(parseUsdc(text)).toBe(expected);
  });

  it.each(['', '0', '0.0', '-1', '1e3', '1,000', '1.0000001', 'abc', '.5', '5.', '0x10'])(
    'rejects %j',
    (text) => {
      expect(parseUsdc(text)).toBeNull();
    },
  );

  it('never loses precision on amounts a float cannot hold', () => {
    expect(parseUsdc('90071992547.409931')).toBe(90_071_992_547_409_931n);
    expect(formatUsdc(90_071_992_547_409_931n)).toBe('90,071,992,547.409931');
  });
});

describe('formatUsdc', () => {
  it.each([
    [100_000_000n, '100.00'],
    [97_500_000n, '97.50'],
    [2_500_000n, '2.50'],
    [1n, '0.000001'],
    [0n, '0.00'],
    [1_234_567_890_000n, '1,234,567.89'],
  ])('formats %s as %s without rounding', (amount, expected) => {
    expect(formatUsdc(amount)).toBe(expected);
    expect(formatUsdc(amount.toString())).toBe(expected);
  });

  it('round-trips what it prints', () => {
    for (const amount of [1n, 39n, 40n, 999_999n, 1_000_001n, 123_456_789n]) {
      expect(parseUsdc(formatUsdc(amount).replaceAll(',', ''))).toBe(amount);
    }
  });
});

describe('durations and addresses', () => {
  it('parses whole hours only', () => {
    expect(parseHours('48')).toBe(172_800n);
    expect(parseHours('1')).toBe(3_600n);
    for (const bad of ['0', '1.5', '-2', '9000', 'two', '']) expect(parseHours(bad)).toBeNull();
  });

  it('formats durations in the largest sensible unit', () => {
    expect([10n, 600n, 7_200n, 172_800n, 604_800n].map(formatDuration)).toEqual([
      '10 s',
      '10 min',
      '2 h',
      '2 d',
      '7 d',
    ]);
  });

  it('shortens addresses', () => {
    expect(shortAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('7xKX…gAsU');
  });
});
