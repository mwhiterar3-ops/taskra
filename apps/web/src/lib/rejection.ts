// The text of a rejection reason. Its hash goes on-chain with `reject_task`;
// the text itself reaches the API only after that transaction is confirmed. A
// text the API would refuse must therefore be refused here, before the wallet
// is asked to sign: afterwards the hash is permanent and the text has nowhere
// to go.

import { rejectionReasonHash, toHex } from '@taskra/sdk';
import { ApiError, type TaskDetail } from './api';

/**
 * The limit of the API (`rejectBody` in apps/api/src/tasks/routes.ts) and of
 * the database (`rejection_reasons.reason`). Both say 5000; they do not count
 * the same thing, which is why `rejectionReasonProblem` checks twice.
 */
export const REJECTION_REASON_MAX = 5_000;

const EMPTY = 'Give a reason. Its hash is recorded on-chain and cannot be changed later.';
const TOO_LONG = `The reason is too long. Keep it within ${REJECTION_REASON_MAX.toLocaleString('en-US')} characters; nothing was sent to your wallet.`;

/**
 * Why `reason` cannot be submitted, or `null` if it can.
 *
 * - The API measures the text as sent, in UTF-16 code units (`string.length`).
 * - The database measures the text as stored (NFC-normalized, trimmed), in
 *   characters. Normalizing can make a text longer, so a text within the first
 *   limit can still break the second.
 */
export function rejectionReasonProblem(reason: string): string | null {
  const stored = reason.normalize('NFC').trim();
  if (stored === '') return EMPTY;
  if (reason.length > REJECTION_REASON_MAX || Array.from(stored).length > REJECTION_REASON_MAX) {
    return TOO_LONG;
  }
  return null;
}

// --- Saving the text after the transaction -----------------------------------

/** The one API call this module makes. */
export interface ReasonApi {
  report(id: string, route: string, body: unknown): Promise<TaskDetail>;
}

export type ReasonSaveResult =
  | { readonly saved: true }
  | {
      readonly saved: false;
      readonly message: string;
      /** False when sending the same text again cannot help. */
      readonly retryable: boolean;
      /** The API no longer recognises the session; the next attempt must sign in first. */
      readonly sessionExpired: boolean;
    };

const failed = (message: string, retryable: boolean, sessionExpired = false): ReasonSaveResult => ({
  saved: false,
  message,
  retryable,
  sessionExpired,
});

/**
 * Sends the reason text for a `reject_task` transaction that is already
 * on-chain, and says whether Taskra now holds it. Never throws and never
 * touches a wallet.
 *
 * Sending the same text for the same signature again is safe: the API checks
 * the text against the hash that transaction recorded, and stores at most one
 * text per task. For the same reason an answer without an error is not proof
 * that this text was stored, so the answer itself is checked: it must show a
 * reason with this text's hash.
 */
export async function saveRejectionReason(
  api: ReasonApi,
  taskId: string,
  signature: string,
  reason: string,
): Promise<ReasonSaveResult> {
  const expected = toHex(rejectionReasonHash(reason));
  let task: TaskDetail;
  try {
    task = await api.report(taskId, 'reject', { signature, reason });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      return failed('The reason could not be sent to Taskra.', true);
    }
    if (error.status === 401) {
      return failed(
        'Your Taskra session ended before the reason was saved. Trying again asks your wallet to sign a sign-in message, not a transaction.',
        true,
        true,
      );
    }
    if (error.status === 0) return failed('Taskra could not be reached.', true);
    if (error.code === 'TRANSACTION_NOT_FOUND') {
      return failed('Taskra has not seen the transaction yet. Try again in a moment.', true);
    }
    if (error.status === 429) return failed('Taskra is receiving too many requests.', true);
    if (error.status >= 500) return failed('Taskra could not save the reason right now.', true);
    return failed(`Taskra refused the reason: ${error.message}`, false);
  }
  if (task.rejection?.reasonHash === expected) return { saved: true };
  return failed(
    'Taskra answered, but it does not show this reason for the task. Its view of the chain may be a moment behind.',
    true,
  );
}

/**
 * True when the chain records a rejection whose text Taskra does not hold.
 * Read from the Task account and the API alone, so it is still true after a
 * reload, when nothing about the attempt is left in the page.
 */
export function hasUnpublishedRejection(
  account: { readonly disputedAt: bigint; readonly rejectionReasonHash: Uint8Array } | null,
  detail: { readonly rejection: unknown },
): boolean {
  return (
    account !== null &&
    account.disputedAt !== 0n &&
    account.rejectionReasonHash.some((byte) => byte !== 0) &&
    detail.rejection === null
  );
}
