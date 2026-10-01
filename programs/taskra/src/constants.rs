use anchor_lang::prelude::*;

#[constant]
pub const PLATFORM_SEED: &[u8] = b"platform";

#[constant]
pub const TASK_SEED: &[u8] = b"task";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Basis points in 100%.
pub const BPS_DENOMINATOR: u16 = 10_000;
