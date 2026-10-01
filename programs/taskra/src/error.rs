use anchor_lang::prelude::*;

#[error_code]
pub enum TaskraError {
    #[msg("fee_bps must not exceed 10000")]
    InvalidFeeBps,
    #[msg("Time windows must be positive")]
    InvalidWindow,
    #[msg("Authority, attester, treasury owner and upgrade authority must be separate keys")]
    KeysNotSeparate,
    #[msg("Signer is not the program upgrade authority")]
    InvalidUpgradeAuthority,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Work duration must be greater than zero")]
    InvalidWorkDuration,
    #[msg("Hash must not be all zeros")]
    ZeroHash,
    #[msg("Escrow balance does not equal the task amount after funding")]
    EscrowBalanceMismatch,
    #[msg("Task is not in a state that allows this instruction")]
    InvalidState,
    #[msg("Signer is not authorized for this instruction")]
    Unauthorized,
    #[msg("The task client cannot accept their own task")]
    ClientCannotAccept,
    #[msg("The work deadline has passed")]
    WorkDeadlinePassed,
    #[msg("Evidence hash does not match the current submission")]
    EvidenceMismatch,
    #[msg("Submission nonce does not match the current submission")]
    NonceMismatch,
    #[msg("The verification deadline has passed")]
    VerificationDeadlinePassed,
    #[msg("The review deadline has passed")]
    ReviewDeadlinePassed,
    #[msg("The review deadline has not passed")]
    ReviewDeadlineNotPassed,
    #[msg("The developer dispute window is not open yet")]
    DisputeWindowNotOpen,
    #[msg("The developer dispute window has closed")]
    DisputeWindowClosed,
    #[msg("The refund is not available yet")]
    RefundNotOpen,
    #[msg("The dispute deadline has passed")]
    DisputeDeadlinePassed,
    #[msg("The dispute deadline has not passed")]
    DisputeDeadlineNotPassed,
    #[msg("An account required for this outcome was not provided")]
    MissingOutcomeAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
