// Typed views of the program's accounts. Every u64/i64 is a bigint; nothing
// here goes through a JavaScript number.

import type { PublicKey } from '@solana/web3.js';
import { BorshReader, decodeFields, type BorshValue } from './borsh.js';
import { bytesEqual } from './bytes.js';
import { type Outcome, outcomeFromIdl, type TaskState, taskStateFromIdl } from './enums.js';
import { TaskraSdkError } from './errors.js';
import { getAccountDiscriminator, getTypeDef, SYSTEM_PROGRAM_ID } from './idl.js';

export interface PlatformAccount {
  readonly authority: PublicKey;
  readonly attester: PublicKey;
  /** USDC token account that receives fees. */
  readonly treasury: PublicKey;
  readonly usdcMint: PublicKey;
  readonly feeBps: number;
  readonly reviewWindow: bigint;
  readonly verificationGrace: bigint;
  readonly disputeTimeout: bigint;
  readonly bump: number;
}

/**
 * The Task account as stored. Timestamps are unix seconds and are `0n` until
 * the transition that sets them has happened, exactly as on-chain.
 */
export interface TaskAccount {
  readonly taskId: Uint8Array;
  readonly client: PublicKey;
  /** `null` until a developer has accepted. */
  readonly developer: PublicKey | null;
  readonly amount: bigint;
  readonly feeBps: number;
  readonly termsHash: Uint8Array;
  readonly state: TaskState;
  readonly outcome: Outcome;
  readonly workDuration: bigint;
  readonly createdAt: bigint;
  readonly acceptedAt: bigint;
  readonly workDeadline: bigint;
  readonly verificationDeadline: bigint;
  readonly submissionNonce: bigint;
  readonly evidenceHash: Uint8Array;
  readonly submittedAt: bigint;
  readonly disputeOpenAt: bigint;
  readonly refundOpenAt: bigint;
  readonly attestedNonce: bigint;
  readonly attestedHash: Uint8Array;
  readonly verifiedAt: bigint;
  readonly reviewDeadline: bigint;
  readonly disputedAt: bigint;
  readonly disputeDeadline: bigint;
  readonly rejectionReasonHash: Uint8Array;
  readonly closedAt: bigint;
  readonly bump: number;
  readonly escrowBump: number;
}

function camelCase(name: string): string {
  return name.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Decodes account data into an object keyed by camelCased IDL field names. */
function decodeAccount(name: 'Platform' | 'Task', data: Uint8Array): Record<string, BorshValue> {
  const discriminator = getAccountDiscriminator(name);
  if (
    data.length < discriminator.length ||
    !bytesEqual(data.subarray(0, discriminator.length), discriminator)
  ) {
    throw new TaskraSdkError('INVALID_ACCOUNT_DATA', `data is not a Taskra ${name} account`);
  }
  const definition = getTypeDef(name);
  if (definition.kind !== 'struct') {
    throw new TaskraSdkError('INVALID_ACCOUNT_DATA', `${name} is not a struct in the IDL`);
  }
  const reader = new BorshReader(data.subarray(discriminator.length));
  const fields = decodeFields(reader, definition.fields);
  if (reader.remaining !== 0) {
    throw new TaskraSdkError('INVALID_ACCOUNT_DATA', `${name} account has unexpected extra data`);
  }
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [camelCase(field), value]),
  );
}

export function decodePlatform(data: Uint8Array): PlatformAccount {
  // The field set is the IDL's; accounts.test.ts checks it matches the interface.
  return decodeAccount('Platform', data) as unknown as PlatformAccount;
}

export function decodeTask(data: Uint8Array): TaskAccount {
  const raw = decodeAccount('Task', data);
  const developer = raw['developer'] as PublicKey;
  return {
    ...(raw as unknown as TaskAccount),
    developer: developer.equals(SYSTEM_PROGRAM_ID) ? null : developer,
    state: taskStateFromIdl(raw['state'] as string),
    outcome: outcomeFromIdl(raw['outcome'] as string),
  };
}
