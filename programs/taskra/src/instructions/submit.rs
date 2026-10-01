use crate::{
    constants::{PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    state::{Platform, Task, TaskState},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    #[account(address = task.developer @ TaskraError::Unauthorized)]
    pub developer: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(
        mut,
        seeds = [TASK_SEED, task.client.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
    )]
    pub task: Account<'info, Task>,
}

/// Records an evidence hash. Also used to resubmit: every call starts a new
/// submission nonce and voids any attestation of the previous one.
pub fn submit_work(ctx: Context<SubmitWork>, evidence_hash: [u8; 32]) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(
        matches!(
            task.state,
            TaskState::Accepted | TaskState::Submitted | TaskState::UnderReview
        ),
        TaskraError::InvalidState
    );
    require!(evidence_hash != [0u8; 32], TaskraError::ZeroHash);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= task.work_deadline, TaskraError::WorkDeadlinePassed);

    let review_window = ctx.accounts.platform.review_window;
    let dispute_open_at = now
        .checked_add(review_window)
        .ok_or(TaskraError::MathOverflow)?
        .max(task.verification_deadline);
    let refund_open_at = dispute_open_at
        .checked_add(review_window)
        .ok_or(TaskraError::MathOverflow)?;

    task.submission_nonce = task
        .submission_nonce
        .checked_add(1)
        .ok_or(TaskraError::MathOverflow)?;
    task.evidence_hash = evidence_hash;
    task.submitted_at = now;
    task.dispute_open_at = dispute_open_at;
    task.refund_open_at = refund_open_at;
    task.attested_nonce = 0;
    task.attested_hash = [0u8; 32];
    task.verified_at = 0;
    task.review_deadline = 0;
    task.state = TaskState::Submitted;
    Ok(())
}
