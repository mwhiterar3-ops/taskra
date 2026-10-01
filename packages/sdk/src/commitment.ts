// Confirmation policy (docs/13-DECISIONS.md §11).

/** Enough to advance a UI flow. Never enough to record a settlement. */
export const UI_PROGRESS_COMMITMENT = 'confirmed';

/** Required before a settlement, refund or reputation change is treated as authoritative. */
export const SETTLEMENT_COMMITMENT = 'finalized';

export type TaskraCommitment = typeof UI_PROGRESS_COMMITMENT | typeof SETTLEMENT_COMMITMENT;

export type CommitmentPurpose = 'ui-progress' | 'settlement-record';

export function commitmentFor(purpose: CommitmentPurpose): TaskraCommitment {
  return purpose === 'settlement-record' ? SETTLEMENT_COMMITMENT : UI_PROGRESS_COMMITMENT;
}

/** True only for `finalized`: the one commitment a financial record may rely on. */
export function isAuthoritativeForSettlement(commitment: string): boolean {
  return commitment === SETTLEMENT_COMMITMENT;
}
