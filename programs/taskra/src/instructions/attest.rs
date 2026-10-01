use crate::{
    constants::{PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    state::{Platform, Task, TaskState},
};
use anchor_lang::prelude::*;

/// Deliberately contains no token account: the attester cannot move funds.
#[derive(Accounts)]
pub struct RecordAttestation<'info> {
    #[account(address = platform.attester @ TaskraError::Unauthorized)]
    pub attester: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(
        mut,
        seeds = [TASK_SEED, task.client.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
    )]
    pub task: Account<'info, Task>,
}

/// Records that the current submission is VERIFIED and starts the review window.
pub fn record_attestation(
    ctx: Context<RecordAttestation>,
    evidence_hash: [u8; 32],
    submission_nonce: u64,
) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(
        task.state == TaskState::Submitted,
        TaskraError::InvalidState
    );
    require!(
        submission_nonce == task.submission_nonce,
        TaskraError::NonceMismatch
    );
    require!(
        evidence_hash == task.evidence_hash,
        TaskraError::EvidenceMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now <= task.verification_deadline,
        TaskraError::VerificationDeadlinePassed
    );

    task.attested_nonce = submission_nonce;
    task.attested_hash = evidence_hash;
    task.verified_at = now;
    task.review_deadline = now
        .checked_add(ctx.accounts.platform.review_window)
        .ok_or(TaskraError::MathOverflow)?;
    task.state = TaskState::UnderReview;
    Ok(())
}
