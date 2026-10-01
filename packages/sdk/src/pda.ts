// Address derivation for every account in docs/13-DECISIONS.md §3.

import { PublicKey } from '@solana/web3.js';
import { invalidArgument, requireBytes, toHex } from './bytes.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  ESCROW_SEED,
  PLATFORM_SEED,
  TASK_SEED,
  TOKEN_PROGRAM_ID,
} from './idl.js';

export const TASK_ID_LENGTH = 16;

/** `["platform"]` */
export function findPlatformAddress(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLATFORM_SEED], programId);
}

/** `["task", client, task_id]` with `task_id` the 16 raw UUID bytes. */
export function findTaskAddress(
  programId: PublicKey,
  client: PublicKey,
  taskId: Uint8Array,
): [PublicKey, number] {
  requireBytes(taskId, TASK_ID_LENGTH, 'taskId');
  return PublicKey.findProgramAddressSync([TASK_SEED, client.toBytes(), taskId], programId);
}

/** `["escrow", task]` */
export function findEscrowAddress(programId: PublicKey, task: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ESCROW_SEED, task.toBytes()], programId);
}

/** The upgradeable loader's ProgramData account for a program. */
export function findProgramDataAddress(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID);
}

/** The associated token account of `owner` for `mint` under the classic token program. */
export function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 16 bytes of a UUID in network order: its hex digits read left to right. */
export function taskIdFromUuid(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw invalidArgument('task id must be a UUID such as 123e4567-e89b-12d3-a456-426614174000');
  }
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(TASK_ID_LENGTH);
  for (let index = 0; index < TASK_ID_LENGTH; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The canonical lower-case UUID string for 16 task-id bytes. */
export function uuidFromTaskId(taskId: Uint8Array): string {
  const hex = toHex(requireBytes(taskId, TASK_ID_LENGTH, 'taskId'));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
