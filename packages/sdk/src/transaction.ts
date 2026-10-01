// Transaction construction. The SDK assembles transactions; wallets approve
// them. Nothing in this package can produce a signature.

import {
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { invalidArgument } from './bytes.js';

export interface UnsignedTransactionInput {
  readonly feePayer: PublicKey;
  /** A recent blockhash fetched by the caller at a commitment of their choice. */
  readonly recentBlockhash: string;
  readonly instructions: readonly TransactionInstruction[];
}

/** A version-0 transaction with every signature slot empty. */
export function buildUnsignedTransaction(input: UnsignedTransactionInput): VersionedTransaction {
  if (input.instructions.length === 0) {
    throw invalidArgument('a transaction needs at least one instruction');
  }
  if (input.recentBlockhash === '') throw invalidArgument('recentBlockhash is required');
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [...input.instructions],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** The accounts whose approval the transaction needs, fee payer first. */
export function requiredApprovals(transaction: VersionedTransaction): PublicKey[] {
  const { staticAccountKeys, header } = transaction.message;
  return staticAccountKeys.slice(0, header.numRequiredSignatures);
}
