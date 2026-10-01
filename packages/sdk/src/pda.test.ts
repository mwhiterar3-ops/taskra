import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CLIENT, MINT, TASK_UUID } from './__fixtures__/fixtures.js';
import { TaskraSdkError } from './errors.js';
import { PROGRAM_ID } from './idl.js';
import {
  findAssociatedTokenAddress,
  findEscrowAddress,
  findPlatformAddress,
  findProgramDataAddress,
  findTaskAddress,
  taskIdFromUuid,
  uuidFromTaskId,
} from './pda.js';

// The same literals are asserted from Rust in programs/taskra/tests/sdk_vectors.rs,
// so the SDK and the program agree on every derivation.
describe('PDA derivation vectors', () => {
  const taskId = taskIdFromUuid(TASK_UUID);

  it('fixtures are the documented inputs', () => {
    expect(CLIENT.toBase58()).toBe('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
    expect(MINT.toBase58()).toBe('8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR');
  });

  it('platform: ["platform"]', () => {
    const [address, bump] = findPlatformAddress(PROGRAM_ID);
    expect(address.toBase58()).toBe('BEbbxHCLBAZkjN4rn7CEEzQBRqL2GVajCzevARCmBkBK');
    expect(bump).toBe(255);
  });

  it('task: ["task", client, task_id]', () => {
    const [address, bump] = findTaskAddress(PROGRAM_ID, CLIENT, taskId);
    expect(address.toBase58()).toBe('FdjWk7omixsmdTin2SvbnN7m9rVDDkBFeTQwy2ViMBPe');
    expect(bump).toBe(254);
  });

  it('escrow: ["escrow", task]', () => {
    const [task] = findTaskAddress(PROGRAM_ID, CLIENT, taskId);
    const [address, bump] = findEscrowAddress(PROGRAM_ID, task);
    expect(address.toBase58()).toBe('CqkX32QzDm5exyR7CHqSxc5kKxFL2HKq3Md8RyRpjJyF');
    expect(bump).toBe(255);
  });

  it('program data: [program id] under the upgradeable loader', () => {
    expect(findProgramDataAddress(PROGRAM_ID)[0].toBase58()).toBe(
      'DwEhJnFHWMFbaGoodUDWFG23fPDVjknHLHH3wxrNZmvM',
    );
  });

  it('associated token account: [owner, token program, mint]', () => {
    expect(findAssociatedTokenAddress(CLIENT, MINT).toBase58()).toBe(
      'CsYkfSfTUTWwnoeRkGchtai5kkYz2SC33kKJwA99wVr3',
    );
  });

  it('gives different tasks to different clients and ids', () => {
    const other = new PublicKey(new Uint8Array(32).fill(8));
    const base = findTaskAddress(PROGRAM_ID, CLIENT, taskId)[0];
    expect(findTaskAddress(PROGRAM_ID, other, taskId)[0].equals(base)).toBe(false);
    const otherId = taskIdFromUuid('00112233-4455-6677-8899-aabbccddeef0');
    expect(findTaskAddress(PROGRAM_ID, CLIENT, otherId)[0].equals(base)).toBe(false);
  });
});

describe('task id', () => {
  it('is the UUID’s hex digits read left to right', () => {
    expect([...taskIdFromUuid(TASK_UUID)]).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
  });

  it('round-trips and lower-cases', () => {
    const upper = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
    expect(uuidFromTaskId(taskIdFromUuid(upper))).toBe(upper.toLowerCase());
  });

  it.each([
    '',
    '00112233445566778899aabbccddeeff',
    '00112233-4455-6677-8899-aabbccddeef',
    '00112233-4455-6677-8899-aabbccddeeffa',
    'g0112233-4455-6677-8899-aabbccddeeff',
    ' 00112233-4455-6677-8899-aabbccddeeff',
  ])('rejects malformed UUID %j', (uuid) => {
    expect(() => taskIdFromUuid(uuid)).toThrow(TaskraSdkError);
  });

  it.each([0, 15, 17, 32])('rejects a %i-byte task id', (length) => {
    expect(() => findTaskAddress(PROGRAM_ID, CLIENT, new Uint8Array(length))).toThrow(
      TaskraSdkError,
    );
    expect(() => uuidFromTaskId(new Uint8Array(length))).toThrow(TaskraSdkError);
  });
});
