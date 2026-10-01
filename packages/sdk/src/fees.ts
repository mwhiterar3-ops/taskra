// Mirrors programs/taskra/src/fees.rs. Informational only: the program
// computes the fee that is actually charged.

import { invalidArgument, requireU64 } from './bytes.js';

export const BPS_DENOMINATOR = 10_000n;

function requireFeeBps(feeBps: unknown): bigint {
  if (
    typeof feeBps !== 'number' ||
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > Number(BPS_DENOMINATOR)
  ) {
    throw invalidArgument('feeBps must be an integer between 0 and 10000');
  }
  return BigInt(feeBps);
}

/** `floor(amount * feeBps / 10000)` in token base units. */
export function computeFee(amount: bigint, feeBps: number): bigint {
  return (requireU64(amount, 'amount') * requireFeeBps(feeBps)) / BPS_DENOMINATOR;
}

export interface SettlementSplit {
  /** Paid to the treasury. */
  readonly fee: bigint;
  /** Paid to the developer: the principal minus the fee. */
  readonly developerAmount: bigint;
}

/** How a developer-paying settlement divides the task amount. */
export function splitSettlement(amount: bigint, feeBps: number): SettlementSplit {
  const fee = computeFee(amount, feeBps);
  return { fee, developerAmount: amount - fee };
}
