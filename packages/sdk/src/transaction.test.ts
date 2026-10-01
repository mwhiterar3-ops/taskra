import { describe, expect, it } from 'vitest';
import {
  ATTESTER,
  bytes32,
  CLIENT,
  CONFIG,
  DEVELOPER,
  key,
  TREASURY,
} from './__fixtures__/fixtures.js';
import { TaskraSdkError } from './errors.js';
import {
  acceptTask,
  approveTask,
  createUsdcAccountIdempotent,
  expireReview,
  recordAttestation,
} from './instructions.js';
import { buildUnsignedTransaction, requiredApprovals } from './transaction.js';

const BLOCKHASH = key(200).toBase58();
const TASK = key(80);
const parties = { task: TASK, client: CLIENT, developer: DEVELOPER, treasury: TREASURY };

describe('buildUnsignedTransaction', () => {
  it('leaves every signature slot empty', () => {
    const transaction = buildUnsignedTransaction({
      feePayer: CLIENT,
      recentBlockhash: BLOCKHASH,
      instructions: [approveTask(CONFIG, { ...parties, evidenceHash: bytes32(1) })],
    });
    expect(transaction.signatures).toHaveLength(1);
    for (const signature of transaction.signatures) {
      expect(signature.every((byte) => byte === 0)).toBe(true);
    }
    expect(transaction.message.recentBlockhash).toBe(BLOCKHASH);
    expect(transaction.version).toBe(0);
  });

  it('lists the fee payer first among the required approvals', () => {
    const payer = key(81);
    const transaction = buildUnsignedTransaction({
      feePayer: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [acceptTask(CONFIG, { developer: DEVELOPER, task: TASK })],
    });
    expect(requiredApprovals(transaction).map((address) => address.toBase58())).toEqual([
      payer.toBase58(),
      DEVELOPER.toBase58(),
    ]);
  });

  it('needs only the fee payer for a permissionless instruction', () => {
    const cranker = key(82);
    const transaction = buildUnsignedTransaction({
      feePayer: cranker,
      recentBlockhash: BLOCKHASH,
      instructions: [
        createUsdcAccountIdempotent(CONFIG, { payer: cranker, owner: DEVELOPER }),
        expireReview(CONFIG, parties),
      ],
    });
    expect(requiredApprovals(transaction).map((address) => address.toBase58())).toEqual([
      cranker.toBase58(),
    ]);
  });

  it('requires the attester, and nobody else, for an attestation', () => {
    const transaction = buildUnsignedTransaction({
      feePayer: ATTESTER,
      recentBlockhash: BLOCKHASH,
      instructions: [
        recordAttestation(CONFIG, {
          attester: ATTESTER,
          task: TASK,
          evidenceHash: bytes32(2),
          submissionNonce: 1n,
        }),
      ],
    });
    expect(requiredApprovals(transaction).map((address) => address.toBase58())).toEqual([
      ATTESTER.toBase58(),
    ]);
  });

  it('rejects an empty instruction list or a missing blockhash', () => {
    expect(() =>
      buildUnsignedTransaction({ feePayer: CLIENT, recentBlockhash: BLOCKHASH, instructions: [] }),
    ).toThrow(TaskraSdkError);
    expect(() =>
      buildUnsignedTransaction({
        feePayer: CLIENT,
        recentBlockhash: '',
        instructions: [acceptTask(CONFIG, { developer: DEVELOPER, task: TASK })],
      }),
    ).toThrow(TaskraSdkError);
  });
});
