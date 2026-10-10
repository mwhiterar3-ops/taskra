// Test doubles for the attestation service: a chain that applies
// record_attestation the way the program does, and a scriptable GitHub.

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  IDL,
  TASKRA_ERROR_CODES,
  type TaskAccount,
  type TaskraCommitment,
  type TaskraErrorName,
  toHex,
} from '@taskra/sdk';
import bs58 from 'bs58';
import type { AttesterChain, SignatureState, TaskRead } from '../chain.js';
import type {
  Commit,
  GithubCallMeta,
  GithubClient,
  GithubOutcome,
  PullRequest,
  Repository,
} from '../github.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REVIEW_WINDOW = 172_800n;

export interface SentAttestation {
  readonly signature: string;
  readonly signer: string;
  readonly task: string;
  readonly evidenceHash: string;
  readonly submissionNonce: bigint;
}

/**
 * What the fake cluster does with a broadcast transaction:
 * - `land`: executes it like the program would (and refuses it in preflight if the program would).
 * - `drop`: accepts it and never includes it.
 * - `reject`: the RPC endpoint is unreachable.
 */
export type SendMode = 'land' | 'drop' | 'reject';

export class FakeAttesterChain implements AttesterChain {
  available = true;
  sendMode: SendMode = 'land';
  time = 1_760_002_000n;
  slot = 500;
  platformAttester: PublicKey;
  readonly sent: SentAttestation[] = [];
  private readonly confirmed = new Map<string, TaskAccount>();
  private readonly finalized = new Map<string, TaskAccount>();
  private readonly states = new Map<string, SignatureState>();

  constructor(
    private readonly programId: PublicKey,
    attester: PublicKey,
  ) {
    this.platformAttester = attester;
  }

  private guard(): void {
    if (!this.available) throw new Error('fetch failed');
  }

  setTask(address: PublicKey, account: TaskAccount, options: { finalized: boolean }): void {
    this.confirmed.set(address.toBase58(), account);
    if (options.finalized) this.finalized.set(address.toBase58(), account);
  }

  taskAt(address: PublicKey, commitment: TaskraCommitment): TaskAccount | undefined {
    return (commitment === 'finalized' ? this.finalized : this.confirmed).get(address.toBase58());
  }

  /** Everything confirmed becomes finalized. */
  finalize(): void {
    for (const [address, account] of this.confirmed) this.finalized.set(address, account);
    for (const [signature, state] of this.states) {
      this.states.set(signature, { ...state, finalized: true });
    }
  }

  getTask(address: PublicKey, commitment: TaskraCommitment): Promise<TaskRead | null> {
    this.guard();
    const account = this.taskAt(address, commitment);
    return Promise.resolve(account === undefined ? null : { account, slot: this.slot });
  }

  getChainTime(): Promise<bigint> {
    this.guard();
    return Promise.resolve(this.time);
  }

  getPlatformAttester(): Promise<PublicKey> {
    this.guard();
    return Promise.resolve(this.platformAttester);
  }

  getLatestBlockhash(): Promise<string> {
    this.guard();
    return Promise.resolve(bs58.encode(randomBytes(32)));
  }

  getSignatureState(signature: string): Promise<SignatureState | null> {
    this.guard();
    return Promise.resolve(this.states.get(signature) ?? null);
  }

  sendTransaction(serialized: Uint8Array): Promise<void> {
    this.guard();
    if (this.sendMode === 'reject') return Promise.reject(new Error('fetch failed'));

    const transaction = VersionedTransaction.deserialize(serialized);
    const { message } = transaction;
    const [signatureBytes] = transaction.signatures;
    const [payer] = message.staticAccountKeys;
    const [instruction, ...others] = message.compiledInstructions;
    if (signatureBytes === undefined || payer === undefined || instruction === undefined) {
      throw new Error('malformed transaction');
    }
    // The fake accepts exactly what the service is allowed to send, and checks
    // that the bytes really were signed by the fee payer.
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, payer.toBytes()]),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, message.serialize(), key, signatureBytes)) {
      throw new Error('signature verification failed');
    }
    const definition = IDL.instructions.find((entry) => entry.name === 'record_attestation');
    const program = message.staticAccountKeys[instruction.programIdIndex];
    if (
      others.length > 0 ||
      definition === undefined ||
      program?.equals(this.programId) !== true ||
      !definition.discriminator.every((byte, index) => instruction.data[index] === byte) ||
      instruction.data.length !== 8 + 32 + 8
    ) {
      throw new Error('the attester sent something other than one record_attestation');
    }
    const account = (index: number): PublicKey => {
      const key = message.staticAccountKeys[instruction.accountKeyIndexes[index] ?? -1];
      if (key === undefined) throw new Error('missing account');
      return key;
    };
    const data = Buffer.from(instruction.data);
    const sent: SentAttestation = {
      signature: bs58.encode(signatureBytes),
      signer: account(0).toBase58(),
      task: account(2).toBase58(),
      evidenceHash: toHex(data.subarray(8, 40)),
      submissionNonce: data.readBigUInt64LE(40),
    };

    const refuse = (name: TaskraErrorName): Promise<void> =>
      Promise.reject(
        new Error(
          `Transaction simulation failed: custom program error: 0x${TASKRA_ERROR_CODES[name].toString(16)}`,
        ),
      );
    const task = this.confirmed.get(sent.task);
    if (this.sendMode === 'land') {
      if (sent.signer !== this.platformAttester.toBase58()) return refuse('Unauthorized');
      if (task?.state !== 'SUBMITTED') return refuse('InvalidState');
      if (toHex(task.evidenceHash) !== sent.evidenceHash) return refuse('EvidenceMismatch');
      if (task.submissionNonce !== sent.submissionNonce) return refuse('NonceMismatch');
      if (this.time > task.verificationDeadline) return refuse('VerificationDeadlinePassed');
      this.confirmed.set(sent.task, {
        ...task,
        state: 'UNDER_REVIEW',
        attestedHash: task.evidenceHash,
        attestedNonce: task.submissionNonce,
        verifiedAt: this.time,
        reviewDeadline: this.time + REVIEW_WINDOW,
      });
      this.states.set(sent.signature, { finalized: false, error: null });
    }
    this.sent.push(sent);
    return Promise.resolve();
  }

  /** Marks a broadcast transaction as executed and failed with a program error. */
  failOnChain(signature: string, name: TaskraErrorName): void {
    this.states.set(signature, {
      finalized: true,
      error: { InstructionError: [0, { Custom: TASKRA_ERROR_CODES[name] }] },
    });
  }
}

const META: GithubCallMeta = {
  endpoint: 'GET /fake',
  status: 200,
  requestId: 'FAKE:1',
  rateLimitRemaining: '59',
};

export const ok = <Value>(value: Value): GithubOutcome<Value> => ({
  kind: 'ok',
  value,
  meta: META,
});
export const notFound = (): GithubOutcome<never> => ({
  kind: 'not_found',
  meta: { ...META, status: 404 },
});
export const unavailable = (reason: string): GithubOutcome<never> => ({
  kind: 'unavailable',
  reason,
  meta: { ...META, status: 503 },
});

export class FakeGithub implements GithubClient {
  pullRequest: GithubOutcome<PullRequest> = notFound();
  repository: GithubOutcome<Repository> = notFound();
  commit: GithubOutcome<Commit> = notFound();
  readonly calls: string[] = [];

  getPullRequest(repo: string, number: bigint): Promise<GithubOutcome<PullRequest>> {
    this.calls.push(`pull ${repo}#${number.toString()}`);
    return Promise.resolve(this.pullRequest);
  }

  getCommit(repo: string, sha: string): Promise<GithubOutcome<Commit>> {
    this.calls.push(`commit ${repo}@${sha.slice(0, 7)}`);
    return Promise.resolve(this.commit);
  }

  getRepository(repo: string): Promise<GithubOutcome<Repository>> {
    this.calls.push(`repo ${repo}`);
    return Promise.resolve(this.repository);
  }
}
