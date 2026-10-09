// Which instructions the connected wallet could send for a task right now.
// This mirrors docs/13-DECISIONS.md §2.6 so the UI offers only what the program
// would accept. It is a convenience: the program decides, and a button shown
// here authorizes nothing.

import { hasValidAttestation, type TaskAccount } from '@taskra/sdk';

export type ActionKind =
  | 'cancel'
  | 'accept'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'refund'
  | 'developer_dispute'
  | 'expire_review'
  | 'resolve_dispute'
  | 'expire_dispute';

export interface TaskAction {
  readonly kind: ActionKind;
  /** False when the role is right but the time window is not open (yet or any more). */
  readonly enabled: boolean;
  /** Why it is disabled, or what the deadline is. */
  readonly note: string | null;
}

export interface ActionContext {
  readonly task: TaskAccount;
  /** The cluster clock (`Clock::unix_timestamp`), not the browser's. */
  readonly chainTime: bigint;
  readonly wallet: string | null;
  readonly platformAuthority: string;
}

const on = (kind: ActionKind, note: string | null = null): TaskAction => ({
  kind,
  enabled: true,
  note,
});
const off = (kind: ActionKind, note: string): TaskAction => ({ kind, enabled: false, note });

export function availableActions(context: ActionContext): TaskAction[] {
  const { task, chainTime: now, wallet } = context;
  if (wallet === null) return [];
  const isClient = wallet === task.client.toBase58();
  const isDeveloper = task.developer !== null && wallet === task.developer.toBase58();
  const isAuthority = wallet === context.platformAuthority;
  const actions: TaskAction[] = [];

  switch (task.state) {
    case 'OPEN':
      if (isClient) actions.push(on('cancel'));
      else actions.push(on('accept'));
      break;

    case 'ACCEPTED':
      if (isDeveloper) {
        actions.push(
          now <= task.workDeadline ? on('submit') : off('submit', 'The work deadline has passed.'),
        );
      }
      if (isClient) {
        actions.push(
          now > task.workDeadline
            ? on('refund')
            : off('refund', 'Available if the work deadline passes with no submission.'),
        );
      }
      break;

    case 'SUBMITTED':
      if (isClient) {
        actions.push(on('approve', 'Not yet verified: approving pays the developer anyway.'));
        actions.push(
          now > task.refundOpenAt
            ? on('refund')
            : off('refund', 'Available if the submission is never verified and not disputed.'),
        );
      }
      if (isDeveloper) {
        if (now <= task.workDeadline)
          actions.push(on('submit', 'Replaces the current submission.'));
        if (now > task.disputeOpenAt && now <= task.refundOpenAt) {
          actions.push(on('developer_dispute'));
        } else if (now <= task.disputeOpenAt) {
          actions.push(
            off('developer_dispute', 'Opens if the submission is not verified in time.'),
          );
        } else {
          actions.push(off('developer_dispute', 'The dispute window has closed.'));
        }
      }
      break;

    case 'UNDER_REVIEW':
      if (isClient) {
        if (now <= task.reviewDeadline) {
          actions.push(on('approve'), on('reject'));
        } else {
          actions.push(off('approve', 'The review window has passed.'));
        }
      }
      if (isDeveloper && now <= task.workDeadline) {
        actions.push(on('submit', 'Replaces the submission and voids its verification.'));
      }
      actions.push(
        now > task.reviewDeadline
          ? on('expire_review', 'Anyone may settle the task now.')
          : off('expire_review', 'Available to anyone once the review window passes.'),
      );
      break;

    case 'DISPUTED':
      if (isAuthority && now <= task.disputeDeadline) actions.push(on('resolve_dispute'));
      actions.push(
        now > task.disputeDeadline
          ? on(
              'expire_dispute',
              hasValidAttestation(task)
                ? 'Pays the developer: the submission was verified.'
                : 'Refunds the client: the submission was never verified.',
            )
          : off('expire_dispute', 'Available to anyone if the dispute is not resolved in time.'),
      );
      break;

    case 'SETTLED':
    case 'REFUNDED':
    case 'CANCELLED':
      break;
  }
  return actions;
}
