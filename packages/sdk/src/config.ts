import { PublicKey } from '@solana/web3.js';
import { invalidArgument } from './bytes.js';
import { PROGRAM_ID, SYSTEM_PROGRAM_ID } from './idl.js';

export const CLUSTERS = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export interface TaskraConfig {
  readonly cluster: Cluster;
  readonly programId: PublicKey;
  /** The USDC mint of the target cluster. Always supplied by the caller. */
  readonly usdcMint: PublicKey;
}

export interface TaskraConfigInput {
  readonly cluster: Cluster;
  readonly usdcMint: PublicKey | string;
  /** Defaults to the address the IDL was built for. */
  readonly programId?: PublicKey | string;
}

function toPublicKey(value: PublicKey | string, name: string): PublicKey {
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(value);
  } catch {
    throw invalidArgument(`${name} is not a valid address`);
  }
}

/**
 * Validates and freezes the SDK configuration. There is deliberately no
 * default mint: a wrong mint must be a configuration error, never a fallback.
 */
export function createTaskraConfig(input: TaskraConfigInput): TaskraConfig {
  if (!CLUSTERS.includes(input.cluster)) {
    throw invalidArgument(`cluster must be one of ${CLUSTERS.join(', ')}`);
  }
  // Runtime guard for untyped callers: the type already requires the mint.
  const mint: unknown = input.usdcMint;
  if (mint === undefined || mint === null || mint === '') {
    throw invalidArgument('usdcMint is required');
  }
  const usdcMint = toPublicKey(input.usdcMint, 'usdcMint');
  if (usdcMint.equals(SYSTEM_PROGRAM_ID)) {
    throw invalidArgument('usdcMint must not be the default address');
  }
  const programId =
    input.programId === undefined ? PROGRAM_ID : toPublicKey(input.programId, 'programId');
  return Object.freeze({ cluster: input.cluster, programId, usdcMint });
}
