// Canonical names (docs/13-DECISIONS.md §2.1) for the program's enums. The
// order of each list is the on-chain variant order.

import { TaskraSdkError } from './errors.js';

export const TASK_STATES = [
  'OPEN',
  'ACCEPTED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['SETTLED', 'REFUNDED', 'CANCELLED'];

export const OUTCOMES = [
  'NONE',
  'CANCELLED',
  'APPROVED',
  'REVIEW_EXPIRED',
  'WORK_DEADLINE_MISSED',
  'NEVER_VERIFIED',
  'DISPUTE_RESOLVED_FOR_DEVELOPER',
  'DISPUTE_RESOLVED_FOR_CLIENT',
  'DISPUTE_EXPIRED_FOR_DEVELOPER',
  'DISPUTE_EXPIRED_FOR_CLIENT',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DISPUTE_RESOLUTIONS = ['PAY_DEVELOPER', 'REFUND_CLIENT'] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

/** `UnderReview` -> `UNDER_REVIEW` */
export function canonicalName(idlVariant: string): string {
  return idlVariant.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toUpperCase();
}

/** `UNDER_REVIEW` -> `UnderReview` */
export function idlVariantName(canonical: string): string {
  return canonical
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join('');
}

function fromIdl<T extends string>(values: readonly T[], idlVariant: string, kind: string): T {
  const name = canonicalName(idlVariant);
  const match = values.find((value) => value === name);
  if (match === undefined) {
    throw new TaskraSdkError('INVALID_ACCOUNT_DATA', `unknown ${kind} ${idlVariant}`);
  }
  return match;
}

export function taskStateFromIdl(idlVariant: string): TaskState {
  return fromIdl(TASK_STATES, idlVariant, 'task state');
}

export function outcomeFromIdl(idlVariant: string): Outcome {
  return fromIdl(OUTCOMES, idlVariant, 'outcome');
}

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}
