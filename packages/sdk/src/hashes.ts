// The canonical implementation of the evidence and terms hashes
// (docs/13-DECISIONS.md §5.2, §5.3, §10.3).
//
//   hash = SHA-256( PREFIX || LP(field_1) || ... || LP(field_n) )
//   LP(x) = byte length of x as a 4-byte big-endian integer, then x

import { sha256 } from '@noble/hashes/sha2.js';
import { invalidArgument, requireU64 } from './bytes.js';

export const EVIDENCE_HASH_PREFIX = 'taskra:evidence:v1';
export const TERMS_HASH_PREFIX = 'taskra:terms:v1';

const encoder = new TextEncoder();

function domainHash(prefix: string, fields: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(prefix)];
  for (const field of fields) {
    const bytes = encoder.encode(field);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length, false);
    parts.push(length, bytes);
  }
  const preimage = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return sha256(preimage);
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `owner/name`, ASCII lower-cased. Rejects URLs, `.git` suffixes and anything else. */
export function canonicalRepo(repo: string): string {
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo.endsWith('.git')) {
    throw invalidArgument('repo must be "owner/name" with no scheme, host or .git suffix');
  }
  return repo.toLowerCase();
}

/**
 * Unicode NFC, then `String.prototype.trim`. This order and these two
 * functions are the definition; other implementations must match them.
 */
export function normalizeAcceptanceCriteria(text: string): string {
  if (typeof text !== 'string') throw invalidArgument('acceptanceCriteria must be a string');
  return text.normalize('NFC').trim();
}

/**
 * The `reason_hash` argument of `reject_task`: plain SHA-256 of the reason
 * text (docs/13-DECISIONS.md §2.5, T10), normalized like acceptance criteria so
 * the browser and the API hash the same bytes.
 */
export function rejectionReasonHash(reason: string): Uint8Array {
  if (typeof reason !== 'string') throw invalidArgument('reason must be a string');
  const normalized = reason.normalize('NFC').trim();
  if (normalized === '') throw invalidArgument('reason must not be empty');
  return sha256(encoder.encode(normalized));
}

export const TASK_TRAILER = 'Taskra-Task';
export const DEVELOPER_TRAILER = 'Taskra-Developer';

/**
 * The two lines the head commit of a pull request must carry for it to count
 * as evidence for a task: which task it is for, and which wallet is to be
 * paid. A commit's message is fixed by its SHA, and the evidence hash commits
 * to the head SHA, so this statement cannot be added or altered afterwards.
 */
export function evidenceTrailers(taskUuid: string, developerWallet: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskUuid)) {
    throw invalidArgument('task id must be a UUID');
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(developerWallet)) {
    throw invalidArgument('developer wallet must be a base58 address');
  }
  return `${TASK_TRAILER}: ${taskUuid.toLowerCase()}\n${DEVELOPER_TRAILER}: ${developerWallet}`;
}

export interface EvidenceHashInput {
  readonly repo: string;
  readonly prNumber: bigint;
  /** The pull request's head commit SHA: 40 hexadecimal characters. */
  readonly headSha: string;
}

export function evidenceHash(input: EvidenceHashInput): Uint8Array {
  const prNumber = requireU64(input.prNumber, 'prNumber');
  if (prNumber === 0n) throw invalidArgument('prNumber must be positive');
  if (typeof input.headSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(input.headSha)) {
    throw invalidArgument('headSha must be 40 hexadecimal characters');
  }
  return domainHash(EVIDENCE_HASH_PREFIX, [
    canonicalRepo(input.repo),
    prNumber.toString(),
    input.headSha.toLowerCase(),
  ]);
}

export interface TermsHashInput {
  readonly repo: string;
  readonly acceptanceCriteria: string;
  /** Seconds. */
  readonly workDuration: bigint;
  /** Token base units. */
  readonly amount: bigint;
}

export function termsHash(input: TermsHashInput): Uint8Array {
  return domainHash(TERMS_HASH_PREFIX, [
    canonicalRepo(input.repo),
    normalizeAcceptanceCriteria(input.acceptanceCriteria),
    requireU64(input.workDuration, 'workDuration').toString(),
    requireU64(input.amount, 'amount').toString(),
  ]);
}

/**
 * Whether off-chain metadata describes an on-chain task: the hash recomputed
 * from the metadata equals the task's `terms_hash`, and the hashed amount and
 * duration are the ones the task records. Metadata that fails this must be
 * shown as unverified and never used for verification (docs/13-DECISIONS.md §5.3).
 */
export function termsMatchTask(
  metadata: TermsHashInput,
  task: {
    readonly termsHash: Uint8Array;
    readonly amount: bigint;
    readonly workDuration: bigint;
  },
): boolean {
  let recomputed: Uint8Array;
  try {
    recomputed = termsHash(metadata);
  } catch {
    return false;
  }
  return (
    recomputed.length === task.termsHash.length &&
    recomputed.every((byte, index) => byte === task.termsHash[index]) &&
    metadata.amount === task.amount &&
    metadata.workDuration === task.workDuration
  );
}
