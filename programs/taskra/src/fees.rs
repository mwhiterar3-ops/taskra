use crate::{constants::BPS_DENOMINATOR, error::TaskraError};
use anchor_lang::prelude::*;

/// `floor(amount * fee_bps / 10000)` in token base units.
pub fn compute_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = u128::from(amount)
        .checked_mul(u128::from(fee_bps))
        .and_then(|product| product.checked_div(u128::from(BPS_DENOMINATOR)))
        .ok_or(TaskraError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| TaskraError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_two_and_a_half_percent_of_100_usdc() {
        assert_eq!(compute_fee(100_000_000, 250).unwrap(), 2_500_000);
    }

    #[test]
    fn floors_fractional_fees() {
        assert_eq!(compute_fee(39, 250).unwrap(), 0);
        assert_eq!(compute_fee(40, 250).unwrap(), 1);
        assert_eq!(compute_fee(79, 250).unwrap(), 1);
        assert_eq!(compute_fee(1, 9_999).unwrap(), 0);
    }

    #[test]
    fn handles_rate_extremes() {
        assert_eq!(compute_fee(123_456, 0).unwrap(), 0);
        assert_eq!(compute_fee(123_456, 10_000).unwrap(), 123_456);
    }

    #[test]
    fn does_not_overflow_at_u64_max() {
        assert_eq!(compute_fee(u64::MAX, 10_000).unwrap(), u64::MAX);
        assert_eq!(compute_fee(u64::MAX, 250).unwrap(), u64::MAX / 40);
    }

    #[test]
    fn never_exceeds_the_amount_for_valid_rates() {
        for amount in [0, 1, 39, 40, 41, 9_999, 10_000, 10_001, u64::MAX] {
            for fee_bps in [0, 1, 250, 9_999, 10_000] {
                assert!(compute_fee(amount, fee_bps).unwrap() <= amount);
            }
        }
    }
}
