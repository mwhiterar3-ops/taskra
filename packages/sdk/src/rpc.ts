// Read helpers. Every one takes the commitment as a required argument: there
// is no default, so a caller always states how final the data must be.

import { PublicKey } from '@solana/web3.js';
import { decodePlatform, decodeTask, type PlatformAccount, type TaskAccount } from './accounts.js';
import type { TaskraCommitment } from './commitment.js';
import type { TaskraConfig } from './config.js';
import { TaskraSdkError } from './errors.js';
import { TOKEN_PROGRAM_ID } from './idl.js';
import { findPlatformAddress } from './pda.js';

/** The part of a web3.js `Connection` these helpers use. */
export interface AccountReader {
  getAccountInfo(
    address: PublicKey,
    commitment: TaskraCommitment,
  ): Promise<{ readonly data: Uint8Array; readonly owner: PublicKey } | null>;
}

const CLOCK_SYSVAR = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const TOKEN_ACCOUNT_LENGTH = 165;
const TOKEN_AMOUNT_OFFSET = 64;

async function readOwned(
  reader: AccountReader,
  address: PublicKey,
  owner: PublicKey,
  commitment: TaskraCommitment,
): Promise<Uint8Array | null> {
  const account = await reader.getAccountInfo(address, commitment);
  if (account === null) return null;
  if (!account.owner.equals(owner)) {
    throw new TaskraSdkError(
      'INVALID_ACCOUNT_DATA',
      `account ${address.toBase58()} is not owned by ${owner.toBase58()}`,
    );
  }
  return account.data;
}

export async function fetchPlatform(
  reader: AccountReader,
  config: TaskraConfig,
  commitment: TaskraCommitment,
): Promise<PlatformAccount> {
  const address = findPlatformAddress(config.programId)[0];
  const data = await readOwned(reader, address, config.programId, commitment);
  if (data === null) {
    throw new TaskraSdkError('ACCOUNT_NOT_FOUND', 'the platform is not initialized');
  }
  return decodePlatform(data);
}

/** The task at `address`, or `null` if no such account exists. */
export async function fetchTask(
  reader: AccountReader,
  config: TaskraConfig,
  address: PublicKey,
  commitment: TaskraCommitment,
): Promise<TaskAccount | null> {
  const data = await readOwned(reader, address, config.programId, commitment);
  return data === null ? null : decodeTask(data);
}

/** The balance of a token account in base units, or `null` if it does not exist. */
export async function fetchTokenAmount(
  reader: AccountReader,
  address: PublicKey,
  commitment: TaskraCommitment,
): Promise<bigint | null> {
  const data = await readOwned(reader, address, TOKEN_PROGRAM_ID, commitment);
  if (data === null) return null;
  if (data.length !== TOKEN_ACCOUNT_LENGTH) {
    throw new TaskraSdkError('INVALID_ACCOUNT_DATA', 'not an SPL token account');
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
    TOKEN_AMOUNT_OFFSET,
    true,
  );
}

/** The cluster's clock (`Clock::unix_timestamp`), which is what the program compares deadlines to. */
export async function fetchChainTime(
  reader: AccountReader,
  commitment: TaskraCommitment,
): Promise<bigint> {
  const account = await reader.getAccountInfo(CLOCK_SYSVAR, commitment);
  if (account === null || account.data.length < 40) {
    throw new TaskraSdkError('ACCOUNT_NOT_FOUND', 'the clock sysvar is unavailable');
  }
  const { data } = account;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true);
}
