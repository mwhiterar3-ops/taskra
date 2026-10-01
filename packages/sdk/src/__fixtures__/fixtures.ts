// Deterministic keys and builders shared by the SDK's unit tests.

import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@solana/web3.js';
import type { PlatformAccount, TaskAccount } from '../accounts.js';
import { createTaskraConfig } from '../config.js';

export function key(fill: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(fill));
}

export const CLIENT = key(1);
export const MINT = key(2);
export const DEVELOPER = key(3);
export const ATTESTER = key(4);
export const AUTHORITY = key(5);
export const TREASURY = key(6);
export const UPGRADE_AUTHORITY = key(7);
export const TASK_UUID = '00112233-4455-6677-8899-aabbccddeeff';

export const CONFIG = createTaskraConfig({ cluster: 'localnet', usdcMint: MINT });

export const HOUR = 3_600n;
export const DAY = 24n * HOUR;
export const START = 1_800_000_000n;

export const PRODUCTION_WINDOWS = {
  reviewWindow: 48n * HOUR,
  verificationGrace: 24n * HOUR,
  disputeTimeout: 7n * DAY,
};

export function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** Anchor's 8-byte discriminator, computed independently of the IDL. */
export function discriminator(namespace: 'global' | 'account', name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8);
}

export function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, value >> 8);
}

export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function i64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function makePlatform(overrides: Partial<PlatformAccount> = {}): PlatformAccount {
  return {
    authority: AUTHORITY,
    attester: ATTESTER,
    treasury: TREASURY,
    usdcMint: MINT,
    feeBps: 250,
    ...PRODUCTION_WINDOWS,
    bump: 255,
    ...overrides,
  };
}

/** An `OPEN` task created at `START`; override fields to move it along. */
export function makeTask(overrides: Partial<TaskAccount> = {}): TaskAccount {
  return {
    taskId: new Uint8Array(16).fill(9),
    client: CLIENT,
    developer: null,
    amount: 100_000_000n,
    feeBps: 250,
    termsHash: bytes32(7),
    state: 'OPEN',
    outcome: 'NONE',
    workDuration: 3n * DAY,
    createdAt: START,
    acceptedAt: 0n,
    workDeadline: 0n,
    verificationDeadline: 0n,
    submissionNonce: 0n,
    evidenceHash: bytes32(0),
    submittedAt: 0n,
    disputeOpenAt: 0n,
    refundOpenAt: 0n,
    attestedNonce: 0n,
    attestedHash: bytes32(0),
    verifiedAt: 0n,
    reviewDeadline: 0n,
    disputedAt: 0n,
    disputeDeadline: 0n,
    rejectionReasonHash: bytes32(0),
    closedAt: 0n,
    bump: 254,
    escrowBump: 255,
    ...overrides,
  };
}
