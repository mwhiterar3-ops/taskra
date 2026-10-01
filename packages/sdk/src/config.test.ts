import { describe, expect, it } from 'vitest';
import { key, MINT } from './__fixtures__/fixtures.js';
import { type Cluster, createTaskraConfig } from './config.js';
import { TaskraSdkError } from './errors.js';
import { IDL } from './generated/idl.js';
import { PROGRAM_ID } from './idl.js';

describe('createTaskraConfig', () => {
  it('defaults the program id to the address in the IDL', () => {
    const config = createTaskraConfig({ cluster: 'devnet', usdcMint: MINT });
    expect(config.programId.toBase58()).toBe(IDL.address);
    expect(config.programId.equals(PROGRAM_ID)).toBe(true);
    expect(config.usdcMint.equals(MINT)).toBe(true);
    expect(config.cluster).toBe('devnet');
  });

  it('accepts addresses as strings', () => {
    const config = createTaskraConfig({
      cluster: 'localnet',
      usdcMint: MINT.toBase58(),
      programId: key(90).toBase58(),
    });
    expect(config.usdcMint.equals(MINT)).toBe(true);
    expect(config.programId.equals(key(90))).toBe(true);
  });

  it('is frozen', () => {
    const config = createTaskraConfig({ cluster: 'localnet', usdcMint: MINT });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('has no default mint: omitting it is an error', () => {
    for (const usdcMint of [undefined, null, '']) {
      expect(() =>
        createTaskraConfig({ cluster: 'devnet', usdcMint: usdcMint as unknown as string }),
      ).toThrow(TaskraSdkError);
    }
  });

  it.each([
    ['a malformed mint', { usdcMint: 'not-an-address' }],
    ['the default address as mint', { usdcMint: '11111111111111111111111111111111' }],
    ['an unknown cluster', { cluster: 'testnet' as Cluster }],
    ['a malformed program id', { programId: 'nope' }],
  ])('rejects %s', (_, override) => {
    expect(() => createTaskraConfig({ cluster: 'devnet', usdcMint: MINT, ...override })).toThrow(
      TaskraSdkError,
    );
  });

  it('contains no mint address in the SDK itself', () => {
    // The IDL names the token program, never a mint.
    expect(JSON.stringify(IDL)).not.toContain(MINT.toBase58());
    expect(Object.keys(createTaskraConfig({ cluster: 'devnet', usdcMint: MINT })).sort()).toEqual([
      'cluster',
      'programId',
      'usdcMint',
    ]);
  });
});
