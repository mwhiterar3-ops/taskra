// Published vectors: docs/13-DECISIONS.md §5.3 (terms) and §10.3 (evidence).
// The same digests are asserted from Rust in programs/taskra/tests/evidence.rs.

import { describe, expect, it } from 'vitest';
import { toHex } from './bytes.js';
import { TaskraSdkError } from './errors.js';
import { canonicalRepo, evidenceHash, normalizeAcceptanceCriteria, termsHash } from './hashes.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

describe('evidenceHash', () => {
  it('reproduces vector E1', () => {
    expect(toHex(evidenceHash({ repo: 'octo-org/parser', prNumber: 42n, headSha: HEAD }))).toBe(
      '926d8ba0f3545c78cdd042d93f7269e67a984224d834bce7a2f379a1303ceef1',
    );
  });

  it('reproduces vector E2', () => {
    expect(toHex(evidenceHash({ repo: 'a/b', prNumber: 1n, headSha: 'f'.repeat(40) }))).toBe(
      '284d3265700774db64c4afa8da7fb252ca9979bbcab298cf379aed52b01791cf',
    );
  });

  it('reproduces vector E3: one more commit changes the hash', () => {
    const next = '0123456789abcdef0123456789abcdef01234568';
    expect(toHex(evidenceHash({ repo: 'octo-org/parser', prNumber: 42n, headSha: next }))).toBe(
      '96c47c4da14961d66d9bfd7844bce5ed80a4bfa7781a0fd29c149f5011749190',
    );
  });

  it('canonicalizes repository and SHA case', () => {
    const canonical = evidenceHash({ repo: 'octo-org/parser', prNumber: 42n, headSha: HEAD });
    expect(
      evidenceHash({ repo: 'Octo-Org/Parser', prNumber: 42n, headSha: HEAD.toUpperCase() }),
    ).toEqual(canonical);
  });

  it('returns 32 bytes', () => {
    expect(evidenceHash({ repo: 'a/b', prNumber: 1n, headSha: HEAD })).toHaveLength(32);
  });

  it.each([
    ['a URL', { repo: 'https://github.com/a/b' }],
    ['a .git suffix', { repo: 'a/b.git' }],
    ['a bare name', { repo: 'parser' }],
    ['three segments', { repo: 'a/b/c' }],
    ['whitespace', { repo: 'a/b ' }],
    ['a newline', { repo: 'a/b\n' }],
    ['an empty repo', { repo: '' }],
    ['a zero PR number', { prNumber: 0n }],
    ['a negative PR number', { prNumber: -1n }],
    ['a number PR number', { prNumber: 42 as unknown as bigint }],
    ['a 39-character SHA', { headSha: HEAD.slice(1) }],
    ['a 41-character SHA', { headSha: `${HEAD}0` }],
    ['a non-hex SHA', { headSha: `g${HEAD.slice(1)}` }],
    ['a 64-character SHA-256', { headSha: '0'.repeat(64) }],
  ])('rejects %s', (_, override) => {
    expect(() => evidenceHash({ repo: 'a/b', prNumber: 1n, headSha: HEAD, ...override })).toThrow(
      TaskraSdkError,
    );
  });
});

describe('termsHash', () => {
  it('reproduces vector T1', () => {
    expect(
      toHex(
        termsHash({
          repo: 'octo-org/parser',
          acceptanceCriteria: 'Parses transaction signatures\nReturns structured output',
          workDuration: 172_800n,
          amount: 100_000_000n,
        }),
      ),
    ).toBe('30847829aaee28ae7add3254b2f0bf44a262467ed115d4f87d041bd53f50c066');
  });

  it('reproduces vector T2: NFC first, then trim', () => {
    const raw = '  Café tests pass \n';
    const digest = 'f3bfcae9cdec77ec36a7223c7c8da9ce001e7d95a9ad72cbb10cd23d0130934c';
    expect(normalizeAcceptanceCriteria(raw)).toBe('Café tests pass');
    expect(new TextEncoder().encode(normalizeAcceptanceCriteria(raw))).toHaveLength(16);
    expect(
      toHex(termsHash({ repo: 'a/b', acceptanceCriteria: raw, workDuration: 1n, amount: 1n })),
    ).toBe(digest);
    // Hashing the already-normalized text gives the same digest.
    expect(
      toHex(
        termsHash({
          repo: 'a/b',
          acceptanceCriteria: 'Café tests pass',
          workDuration: 1n,
          amount: 1n,
        }),
      ),
    ).toBe(digest);
  });

  it('trims exactly what String.prototype.trim trims', () => {
    // U+FEFF and U+00A0 are trimmed; U+0085 (NEL) and U+200B are not.
    expect(normalizeAcceptanceCriteria('﻿ \t x  　')).toBe('x');
    expect(normalizeAcceptanceCriteria('\u0085x​')).toBe('\u0085x​');
    // Interior whitespace and line breaks are preserved.
    expect(normalizeAcceptanceCriteria(' a  b\r\nc ')).toBe('a  b\r\nc');
  });

  it('distinguishes every field', () => {
    const base = { repo: 'a/b', acceptanceCriteria: 'x', workDuration: 1n, amount: 1n };
    const digests = [
      termsHash(base),
      termsHash({ ...base, repo: 'a/c' }),
      termsHash({ ...base, acceptanceCriteria: 'y' }),
      termsHash({ ...base, workDuration: 2n }),
      termsHash({ ...base, amount: 2n }),
      // Field boundaries are unambiguous: "1" + "11" is not "11" + "1".
      termsHash({ ...base, workDuration: 1n, amount: 11n }),
      termsHash({ ...base, workDuration: 11n, amount: 1n }),
    ].map(toHex);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('writes large amounts in full decimal precision', () => {
    const big = { repo: 'a/b', acceptanceCriteria: 'x', workDuration: 1n };
    expect(toHex(termsHash({ ...big, amount: 9_007_199_254_740_993n }))).not.toBe(
      toHex(termsHash({ ...big, amount: 9_007_199_254_740_992n })),
    );
    expect(termsHash({ ...big, amount: 18_446_744_073_709_551_615n })).toHaveLength(32);
  });

  it('uses a different domain from the evidence hash', () => {
    expect(
      toHex(termsHash({ repo: 'a/b', acceptanceCriteria: '', workDuration: 1n, amount: 1n })),
    ).not.toBe(toHex(evidenceHash({ repo: 'a/b', prNumber: 1n, headSha: HEAD })));
  });

  it.each([
    ['a number amount', { amount: 1 as unknown as bigint }],
    ['a negative amount', { amount: -1n }],
    ['an amount above u64', { amount: 1n << 64n }],
    ['a number duration', { workDuration: 60 as unknown as bigint }],
    ['a non-string criteria', { acceptanceCriteria: 5 as unknown as string }],
    ['a bad repo', { repo: 'a b/c' }],
  ])('rejects %s', (_, override) => {
    expect(() =>
      termsHash({
        repo: 'a/b',
        acceptanceCriteria: 'x',
        workDuration: 1n,
        amount: 1n,
        ...override,
      }),
    ).toThrow(TaskraSdkError);
  });
});

describe('canonicalRepo', () => {
  it('lower-cases ASCII and keeps permitted punctuation', () => {
    expect(canonicalRepo('Octo-Org/My_Repo.js')).toBe('octo-org/my_repo.js');
  });
});
