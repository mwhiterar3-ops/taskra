use anchor_lang::prelude::*;

/// Singleton configuration. Only `authority`, `attester` and `treasury` can
/// change after initialization (see `rotate_keys`).
#[account]
#[derive(InitSpace)]
pub struct Platform {
    /// Resolves disputes and rotates keys.
    pub authority: Pubkey,
    /// May record attestations and nothing else.
    pub attester: Pubkey,
    /// USDC token account that receives fees.
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_bps: u16,
    pub review_window: i64,
    pub verification_grace: i64,
    pub dispute_timeout: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TaskState {
    Open,
    Accepted,
    Submitted,
    UnderReview,
    Disputed,
    Settled,
    Refunded,
    Cancelled,
}

/// How a task reached its terminal state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    None,
    Cancelled,
    Approved,
    ReviewExpired,
    WorkDeadlineMissed,
    NeverVerified,
    DisputeResolvedForDeveloper,
    DisputeResolvedForClient,
    DisputeExpiredForDeveloper,
    DisputeExpiredForClient,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisputeResolution {
    PayDeveloper,
    RefundClient,
}

/// Economically relevant task state. Never closed: once terminal it is the
/// permanent on-chain work record.
#[account]
#[derive(InitSpace)]
pub struct Task {
    pub task_id: [u8; 16],
    pub client: Pubkey,
    /// `Pubkey::default()` until accepted.
    pub developer: Pubkey,
    /// Escrowed amount in token base units.
    pub amount: u64,
    /// Fee rate copied from the platform at creation.
    pub fee_bps: u16,
    /// SHA-256 of the canonical off-chain task terms.
    pub terms_hash: [u8; 32],
    pub state: TaskState,
    pub outcome: Outcome,
    pub work_duration: i64,
    pub created_at: i64,
    pub accepted_at: i64,
    pub work_deadline: i64,
    pub verification_deadline: i64,
    /// Incremented by every submission; an attestation is valid for one nonce only.
    pub submission_nonce: u64,
    pub evidence_hash: [u8; 32],
    pub submitted_at: i64,
    pub dispute_open_at: i64,
    pub refund_open_at: i64,
    pub attested_nonce: u64,
    pub attested_hash: [u8; 32],
    /// Zero while no attestation exists for the current submission.
    pub verified_at: i64,
    pub review_deadline: i64,
    pub disputed_at: i64,
    pub dispute_deadline: i64,
    pub rejection_reason_hash: [u8; 32],
    pub closed_at: i64,
    pub bump: u8,
    pub escrow_bump: u8,
}

impl Task {
    /// True when a VERIFIED attestation exists for the current evidence hash
    /// and submission nonce.
    pub fn has_valid_attestation(&self) -> bool {
        self.verified_at != 0
            && self.attested_nonce == self.submission_nonce
            && self.attested_hash == self.evidence_hash
    }
}
