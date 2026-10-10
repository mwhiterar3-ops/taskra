use anchor_lang::prelude::*;

#[constant]
pub const PLATFORM_SEED: &[u8] = b"platform";

#[constant]
pub const TASK_SEED: &[u8] = b"task";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Longest `work_duration` a task may be created with: 365 days.
///
/// Together with `MAX_WINDOW` this bounds every deadline the program computes
/// to at most five years after the transaction that sets it, so the checked
/// additions in `accept_task`, `submit_work`, `record_attestation` and the
/// dispute instructions cannot overflow for any clock value a cluster can
/// reach, and every deadline is reachable. Without a bound, a duration near
/// `i64::MAX` let a task be accepted but never submitted, cancelled or refunded.
#[constant]
pub const MAX_WORK_DURATION: i64 = 365 * 24 * 60 * 60;

/// Longest value of each platform time window: 365 days.
#[constant]
pub const MAX_WINDOW: i64 = 365 * 24 * 60 * 60;

/// Basis points in 100%.
pub const BPS_DENOMINATOR: u16 = 10_000;
