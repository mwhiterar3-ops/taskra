// The text of a rejection reason. Its hash goes on-chain with `reject_task`;
// the text itself reaches the API only after that transaction is confirmed. A
// text the API would refuse must therefore be refused here, before the wallet
// is asked to sign: afterwards the hash is permanent and the text has nowhere
// to go.

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
