// Helpers for the end-to-end scripts. These hold test keypairs and sign
// transactions, which is exactly what the SDK itself never does: everything
// under e2e/ is tooling around the SDK, not part of it.

import { readFileSync } from 'node:fs';
import {
  type Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  buildUnsignedTransaction,
  decodeProgramError,
  initializePlatform,
  type TaskraCommitment,
  type TaskraConfig,
} from '../src/index.js';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`environment variable ${name} is required`);
  }
  return value;
}

export function envBigInt(name: string): bigint {
  const value = requireEnv(name);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

export function envPublicKey(name: string): PublicKey {
  try {
    return new PublicKey(requireEnv(name));
  } catch {
    throw new Error(`${name} must be a base58 address`);
  }
}

/** Reads a Solana CLI keypair file (a JSON array of 64 bytes). */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

function describeFailure(label: string, error: unknown): Error {
  const decoded = decodeProgramError(error);
  const reason =
    decoded === null
      ? error instanceof Error
        ? error.message
        : JSON.stringify(error)
      : decoded.kind === 'unknown'
        ? `custom program error ${String(decoded.code)}`
        : `${decoded.name} (${String(decoded.code)})`;
  return new Error(`${label} failed: ${reason}`, { cause: error });
}

/**
 * Builds the transaction through the SDK, signs it with the given keypairs
 * (the first pays the fee), sends it and waits for `commitment`.
 */
export async function send(
  connection: Connection,
  label: string,
  instructions: readonly TransactionInstruction[],
  signers: readonly [Keypair, ...Keypair[]],
  commitment: TaskraCommitment,
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = buildUnsignedTransaction({
    feePayer: signers[0].publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  });
  transaction.sign([...signers]);

  let signature: string;
  try {
    signature = await connection.sendTransaction(transaction, { preflightCommitment: 'confirmed' });
  } catch (error) {
    throw describeFailure(label, error);
  }
  const result = await connection.confirmTransaction({ signature, ...latest }, commitment);
  if (result.value.err !== null) throw describeFailure(label, result.value.err);

  console.log(`  ${label}`);
  console.log(`      signature   ${signature}`);
  console.log(`      commitment  ${commitment}`);
  return signature;
}

/** Sends a transaction that the program must refuse, and returns the decoded reason. */
export async function expectRejection(
  connection: Connection,
  label: string,
  instructions: readonly TransactionInstruction[],
  signers: readonly [Keypair, ...Keypair[]],
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = buildUnsignedTransaction({
    feePayer: signers[0].publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  });
  transaction.sign([...signers]);
  try {
    await connection.sendTransaction(transaction, { preflightCommitment: 'confirmed' });
  } catch (error) {
    const decoded = decodeProgramError(error);
    if (decoded === null || decoded.kind === 'unknown') throw describeFailure(label, error);
    console.log(`  ${label}`);
    console.log(`      refused by the program: ${decoded.name} (${String(decoded.code)})`);
    return decoded.name;
  }
  throw new Error(`${label}: the program accepted a transaction it should have refused`);
}

export async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
}

export interface PlatformSetup {
  readonly treasury: PublicKey;
  readonly authority: PublicKey;
  readonly attester: PublicKey;
  readonly feeBps: number;
  readonly reviewWindow: bigint;
  readonly verificationGrace: bigint;
  readonly disputeTimeout: bigint;
}

/** Sends `initialize_platform`, signed by the program's upgrade authority. */
export async function initializePlatformOnChain(
  connection: Connection,
  config: TaskraConfig,
  upgradeAuthority: Keypair,
  setup: PlatformSetup,
): Promise<string> {
  return send(
    connection,
    'initialize_platform',
    [initializePlatform(config, { upgradeAuthority: upgradeAuthority.publicKey, ...setup })],
    [upgradeAuthority],
    'finalized',
  );
}
