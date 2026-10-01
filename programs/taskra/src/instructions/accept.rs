use crate::{
    constants::{PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    state::{Platform, Task, TaskState},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AcceptTask<'info> {
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

pub fn accept_task(ctx: Context<AcceptTask>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(task.state == TaskState::Open, TaskraError::InvalidState);
    require_keys_neq!(
        ctx.accounts.developer.key(),
        task.client,
        TaskraError::ClientCannotAccept
    );

    let now = Clock::get()?.unix_timestamp;
    let work_deadline = now
        .checked_add(task.work_duration)
        .ok_or(TaskraError::MathOverflow)?;
    let verification_deadline = work_deadline
        .checked_add(ctx.accounts.platform.verification_grace)
        .ok_or(TaskraError::MathOverflow)?;

    task.developer = ctx.accounts.developer.key();
    task.accepted_at = now;
    task.work_deadline = work_deadline;
    task.verification_deadline = verification_deadline;
    task.state = TaskState::Accepted;
    Ok(())
}
