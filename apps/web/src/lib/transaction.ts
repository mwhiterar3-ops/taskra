// One transaction, from "build" to "finalized", as explicit states. The UI
// renders the state it is given and nothing else, so it cannot show success
// for a transaction that failed, was declined, expired or is merely pending.
//
//   building -> awaiting_signature -> submitted -> confirmed -> finalized
//        \________________\_____________\____________\________-> failed
//
// `confirmed` is progress. Only `finalized` is final (docs/13-DECISIONS.md §11).

import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildUnsignedTransaction, decodeProgramError } from '@taskra/sdk';
import bs58 from 'bs58';
import { WalletError, type WalletPort } from './wallet';

export type TxFailureKind =
  'rejected' | 'wallet' | 'insufficient_funds' | 'program' | 'expired' | 'network';

export interface TxFailure {
  readonly kind: TxFailureKind;
  readonly message: string;
  /** The program's error name, when there is one. */
  readonly code: string | null;
}

export type TxState =
  | { readonly phase: 'building' }
  | { readonly phase: 'awaiting_signature' }
  | { readonly phase: 'submitted'; readonly signature: string }
  | { readonly phase: 'confirmed'; readonly signature: string }
  | { readonly phase: 'finalized'; readonly signature: string }
  | { readonly phase: 'failed'; readonly signature: string | null; readonly failure: TxFailure };

interface SignatureStatus {
  readonly err: unknown;
  readonly confirmationStatus?: string | null;
}

/** The part of a web3.js `Connection` a transaction needs. */
export interface TxRpc {
  getLatestBlockhash(
    commitment: 'confirmed',
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(
    raw: Uint8Array,
    options: { preflightCommitment: 'confirmed' },
  ): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment: 'confirmed'): Promise<number>;
}

export interface RunTransactionInput {
  readonly rpc: TxRpc;
  readonly wallet: WalletPort;
  readonly feePayer: PublicKey;
  readonly instructions: readonly TransactionInstruction[];
  readonly onState: (state: TxState) => void;
  /** Called once, when the transaction is first seen confirmed (to report it to the API). */
  readonly onConfirmed?: (signature: string) => Promise<void>;
  readonly pollMs?: number;
}

const PROGRAM_MESSAGES: Readonly<Record<string, string>> = {
  InvalidState: 'The task is no longer in a state that allows this.',
  Unauthorized: 'This wallet is not allowed to do that for this task.',
  ClientCannotAccept: 'The client of a task cannot accept it.',
  WorkDeadlinePassed: 'The work deadline has passed.',
  EvidenceMismatch: 'The evidence changed since you last looked. Reload and review it again.',
  ReviewDeadlinePassed: 'The review window has passed.',
  ReviewDeadlineNotPassed: 'The review window has not passed yet.',
  DisputeWindowNotOpen: 'The dispute window is not open yet.',
  DisputeWindowClosed: 'The dispute window has closed.',
  RefundNotOpen: 'A refund is not available yet.',
  DisputeDeadlinePassed: 'The dispute deadline has passed.',
  DisputeDeadlineNotPassed: 'The dispute deadline has not passed yet.',
};

/** Turns whatever the wallet or the RPC endpoint threw into something a person can act on. */
export function classifyFailure(error: unknown): TxFailure {
  if (error instanceof WalletError) {
    return {
      kind: error.kind === 'rejected' ? 'rejected' : 'wallet',
      message: error.message,
      code: null,
    };
  }
  const text = [
    error instanceof Error ? error.message : JSON.stringify(error),
    ...(((error as { logs?: unknown } | null)?.logs as string[] | undefined) ?? []),
  ].join('\n');
  const decoded = decodeProgramError(error);
  if (decoded !== null && decoded.kind !== 'unknown') {
    return {
      kind: 'program',
      message: PROGRAM_MESSAGES[decoded.name] ?? `The program refused: ${decoded.name}.`,
      code: decoded.name,
    };
  }
  if (/insufficient funds|insufficient lamports|custom program error: 0x1\b/i.test(text)) {
    return {
      kind: 'insufficient_funds',
      message: 'This wallet does not hold enough USDC or SOL for this transaction.',
      code: null,
    };
  }
  if (/blockhash not found|block height exceeded|expired/i.test(text)) {
    return {
      kind: 'expired',
      message: 'The transaction expired before it was included. Nothing happened; try again.',
      code: null,
    };
  }
  if (decoded !== null) {
    return {
      kind: 'program',
      message: 'The transaction was refused by a program.',
      code: `0x${decoded.code.toString(16)}`,
    };
  }
  return {
    kind: 'network',
    message: 'The Solana RPC endpoint could not be reached. Check the task before retrying.',
    code: null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_POLL_ERRORS = 5;

/**
 * Runs one transaction to finality. Resolves with the final state, which is
 * either `finalized` or `failed`; it never throws and never reports success
 * for anything less than finality.
 */
export async function runTransaction(input: RunTransactionInput): Promise<TxState> {
  const { rpc, wallet, onState } = input;
  const pollMs = input.pollMs ?? 1_000;
  let signature: string | null = null;
  const emit = (state: TxState): TxState => {
    onState(state);
    return state;
  };
  const fail = (error: unknown): TxState =>
    emit({ phase: 'failed', signature, failure: classifyFailure(error) });

  let lastValidBlockHeight: number;
  try {
    emit({ phase: 'building' });
    const latest = await rpc.getLatestBlockhash('confirmed');
    lastValidBlockHeight = latest.lastValidBlockHeight;
    const unsigned = buildUnsignedTransaction({
      feePayer: input.feePayer,
      recentBlockhash: latest.blockhash,
      instructions: input.instructions,
    });

    emit({ phase: 'awaiting_signature' });
    const signed = await wallet.signTransaction(unsigned);
    const [first] = signed.signatures;
    if (first === undefined) throw new WalletError('failed', 'The wallet returned no signature.');
    // Known before sending, so a crash after the send cannot lose track of it.
    signature = bs58.encode(first);
    await rpc.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
  } catch (error) {
    // Nothing was broadcast, or the node refused it: there is no signature to follow.
    signature = null;
    return fail(error);
  }

  emit({ phase: 'submitted', signature });
  let confirmed = false;
  let pollErrors = 0;
  for (;;) {
    await sleep(pollMs);
    let status: SignatureStatus | null;
    try {
      status = (await rpc.getSignatureStatuses([signature])).value[0] ?? null;
      if (status === null && (await rpc.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        return fail(new Error('block height exceeded'));
      }
      pollErrors = 0;
    } catch (error) {
      pollErrors += 1;
      // The transaction may still land. Say so; never guess that it did.
      if (pollErrors >= MAX_POLL_ERRORS) return fail(error);
      continue;
    }
    if (status === null) continue;
    if (status.err !== null) return fail({ err: status.err });

    const level = status.confirmationStatus;
    if (!confirmed && (level === 'confirmed' || level === 'finalized')) {
      confirmed = true;
      emit({ phase: 'confirmed', signature });
      // Reporting is a courtesy to the API; the chain is already authoritative.
      await input.onConfirmed?.(signature).catch(() => undefined);
    }
    if (level === 'finalized') return emit({ phase: 'finalized', signature });
  }
}
