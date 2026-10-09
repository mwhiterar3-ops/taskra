// Wallet login: a server-built message, signed by the wallet, verified here.
// The signature is a message signature. It is never a transaction and the
// session it yields cannot move funds (docs/14-API-CONTRACT.md §4).

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import bs58 from 'bs58';

/** How long a login challenge can be answered. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Absolute session lifetime; there is no sliding renewal. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
export const SESSION_COOKIE = 'taskra_session';

/** 256 random bits, base64url: 43 characters. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface ChallengeFields {
  /** Origin of the web app the user is signing in to. */
  readonly webOrigin: string;
  readonly network: string;
  readonly wallet: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The text the wallet signs. It names the site, the wallet, the cluster and a
 * single-use nonce, so a signature for one of them is useless for another, and
 * it begins with prose, so it can never be mistaken for a transaction.
 */
export function buildChallengeMessage(fields: ChallengeFields): string {
  return [
    `${new URL(fields.webOrigin).host} wants you to sign in with your Solana account:`,
    fields.wallet,
    '',
    'Sign in to Taskra. This proves you control this wallet. It is not a transaction and cannot move funds.',
    '',
    `URI: ${fields.webOrigin}`,
    'Version: 1',
    `Chain ID: solana:${fields.network}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expiresAt.toISOString()}`,
  ].join('\n');
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeBase58(value: string, length: number): Uint8Array | null {
  try {
    const bytes = bs58.decode(value);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

/** True only if `signature` is `wallet`'s Ed25519 signature over exactly `message`. */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  const publicKey = decodeBase58(wallet, 32);
  const signatureBytes = decodeBase58(signature, 64);
  if (publicKey === null || signatureBytes === null) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, signatureBytes);
  } catch {
    return false;
  }
}
