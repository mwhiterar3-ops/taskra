import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ATTESTER,
  AUTHORITY,
  concat,
  CONFIG,
  discriminator,
  i64le,
  key,
  MINT,
  TREASURY,
  u16le,
  u64le,
} from './__fixtures__/fixtures.js';
import {
  commitmentFor,
  isAuthoritativeForSettlement,
  SETTLEMENT_COMMITMENT,
  type TaskraCommitment,
  UI_PROGRESS_COMMITMENT,
} from './commitment.js';
import { TaskraSdkError } from './errors.js';
import { PROGRAM_ID, TOKEN_PROGRAM_ID } from './idl.js';
import { findPlatformAddress } from './pda.js';
import {
  type AccountReader,
  fetchChainTime,
  fetchPlatform,
  fetchTask,
  fetchTokenAmount,
} from './rpc.js';

const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const PLATFORM = findPlatformAddress(PROGRAM_ID)[0];
const TOKEN_ACCOUNT = key(50);

const platformData = concat(
  discriminator('account', 'Platform'),
  AUTHORITY.toBytes(),
  ATTESTER.toBytes(),
  TREASURY.toBytes(),
  MINT.toBytes(),
  u16le(250),
  i64le(172_800n),
  i64le(86_400n),
  i64le(604_800n),
  Uint8Array.of(255),
);
const tokenData = concat(
  new Uint8Array(64),
  u64le(18_446_744_073_709_551_615n),
  new Uint8Array(93),
);
const clockData = concat(new Uint8Array(32), i64le(1_800_000_123n));

/** A reader that records the commitment of every call. */
function fakeReader(accounts: Map<string, { data: Uint8Array; owner: PublicKey }>) {
  const calls: TaskraCommitment[] = [];
  const reader: AccountReader = {
    getAccountInfo(address, commitment) {
      calls.push(commitment);
      return Promise.resolve(accounts.get(address.toBase58()) ?? null);
    },
  };
  return { reader, calls };
}

const accounts = new Map([
  [PLATFORM.toBase58(), { data: platformData, owner: PROGRAM_ID }],
  [TOKEN_ACCOUNT.toBase58(), { data: tokenData, owner: TOKEN_PROGRAM_ID }],
  [CLOCK.toBase58(), { data: clockData, owner: key(60) }],
]);

describe('commitment policy', () => {
  it('uses confirmed for UI progress and finalized for settlement records', () => {
    expect(UI_PROGRESS_COMMITMENT).toBe('confirmed');
    expect(SETTLEMENT_COMMITMENT).toBe('finalized');
    expect(commitmentFor('ui-progress')).toBe('confirmed');
    expect(commitmentFor('settlement-record')).toBe('finalized');
  });

  it('treats only finalized as authoritative for a settlement', () => {
    expect(isAuthoritativeForSettlement('finalized')).toBe(true);
    for (const commitment of ['confirmed', 'processed', 'recent', '']) {
      expect(isAuthoritativeForSettlement(commitment)).toBe(false);
    }
  });
});

describe('RPC helpers', () => {
  it('pass the caller’s commitment through unchanged', async () => {
    const { reader, calls } = fakeReader(accounts);
    await fetchPlatform(reader, CONFIG, 'finalized');
    await fetchPlatform(reader, CONFIG, 'confirmed');
    await fetchTokenAmount(reader, TOKEN_ACCOUNT, 'finalized');
    await fetchChainTime(reader, 'confirmed');
    await fetchTask(reader, CONFIG, key(70), 'finalized');
    expect(calls).toEqual(['finalized', 'confirmed', 'finalized', 'confirmed', 'finalized']);
  });

  it('have no default commitment', () => {
    const { reader } = fakeReader(accounts);
    // Each call below omits the commitment and must not compile.
    const uncompilable = [
      // @ts-expect-error commitment is required
      () => fetchPlatform(reader, CONFIG),
      // @ts-expect-error commitment is required
      () => fetchTask(reader, CONFIG, key(70)),
      // @ts-expect-error commitment is required
      () => fetchTokenAmount(reader, TOKEN_ACCOUNT),
      // @ts-expect-error commitment is required
      () => fetchChainTime(reader),
      // @ts-expect-error "processed" is not an accepted commitment
      () => fetchChainTime(reader, 'processed'),
    ];
    expect(uncompilable).toHaveLength(5);
    expect(fetchPlatform.length).toBe(3);
    expect(fetchTask.length).toBe(4);
    expect(fetchTokenAmount.length).toBe(3);
    expect(fetchChainTime.length).toBe(2);
  });

  it('decode what they read', async () => {
    const { reader } = fakeReader(accounts);
    const platform = await fetchPlatform(reader, CONFIG, 'finalized');
    expect(platform.treasury.equals(TREASURY)).toBe(true);
    expect(platform.disputeTimeout).toBe(604_800n);
    expect(await fetchTokenAmount(reader, TOKEN_ACCOUNT, 'finalized')).toBe(
      18_446_744_073_709_551_615n,
    );
    expect(await fetchChainTime(reader, 'confirmed')).toBe(1_800_000_123n);
  });

  it('report missing accounts explicitly', async () => {
    const { reader } = fakeReader(new Map());
    await expect(fetchPlatform(reader, CONFIG, 'finalized')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(await fetchTask(reader, CONFIG, key(70), 'finalized')).toBeNull();
    expect(await fetchTokenAmount(reader, TOKEN_ACCOUNT, 'finalized')).toBeNull();
    await expect(fetchChainTime(reader, 'confirmed')).rejects.toBeInstanceOf(TaskraSdkError);
  });

  it('refuse accounts owned by another program', async () => {
    const impostor = key(99);
    const { reader } = fakeReader(
      new Map([
        [PLATFORM.toBase58(), { data: platformData, owner: impostor }],
        [TOKEN_ACCOUNT.toBase58(), { data: tokenData, owner: impostor }],
      ]),
    );
    await expect(fetchPlatform(reader, CONFIG, 'finalized')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_DATA',
    });
    await expect(fetchTask(reader, CONFIG, PLATFORM, 'finalized')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_DATA',
    });
    await expect(fetchTokenAmount(reader, TOKEN_ACCOUNT, 'finalized')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_DATA',
    });
  });

  it('refuse a token account of the wrong size', async () => {
    const { reader } = fakeReader(
      new Map([[TOKEN_ACCOUNT.toBase58(), { data: new Uint8Array(82), owner: TOKEN_PROGRAM_ID }]]),
    );
    await expect(fetchTokenAmount(reader, TOKEN_ACCOUNT, 'finalized')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_DATA',
    });
  });
});
