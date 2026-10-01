use crate::{
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    settlement::{finalize, Escrow},
    state::{Outcome, Platform, Task, TaskState},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct ApproveTask<'info> {
    #[account(mut, address = task.client @ TaskraError::Unauthorized)]
    pub client: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(
        mut,
        seeds = [TASK_SEED, task.client.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
    )]
    pub task: Box<Account<'info, Task>>,
    #[account(address = platform.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, task.key().as_ref()],
        bump = task.escrow_bump,
        token::mint = usdc_mint,
        token::authority = task,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = task.developer,
    )]
    pub developer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = platform.treasury, token::mint = usdc_mint)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// The client accepts the work they reviewed (`evidence_hash`) and pays the developer.
pub fn approve_task(ctx: Context<ApproveTask>, evidence_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    match task.state {
        TaskState::Submitted => {}
        TaskState::UnderReview => {
            require!(
                now <= task.review_deadline,
                TaskraError::ReviewDeadlinePassed
            );
        }
        _ => return err!(TaskraError::InvalidState),
    }
    require!(
        evidence_hash == task.evidence_hash,
        TaskraError::EvidenceMismatch
    );

    Escrow {
        task: &ctx.accounts.task,
        escrow: &ctx.accounts.escrow,
        usdc_mint: &ctx.accounts.usdc_mint,
        client: ctx.accounts.client.to_account_info(),
        token_program: &ctx.accounts.token_program,
    }
    .pay_developer(&ctx.accounts.developer_token, &ctx.accounts.treasury)?;
    finalize(
        &mut ctx.accounts.task,
        TaskState::Settled,
        Outcome::Approved,
        now,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RejectTask<'info> {
    #[account(address = task.client @ TaskraError::Unauthorized)]
    pub client: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(
        mut,
        seeds = [TASK_SEED, task.client.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
    )]
    pub task: Account<'info, Task>,
}

/// The client rejects verified work within the review window. Moves no funds.
pub fn reject_task(ctx: Context<RejectTask>, reason_hash: [u8; 32]) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(
        task.state == TaskState::UnderReview,
        TaskraError::InvalidState
    );
    require!(reason_hash != [0u8; 32], TaskraError::ZeroHash);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now <= task.review_deadline,
        TaskraError::ReviewDeadlinePassed
    );

    task.rejection_reason_hash = reason_hash;
    task.disputed_at = now;
    task.dispute_deadline = now
        .checked_add(ctx.accounts.platform.dispute_timeout)
        .ok_or(TaskraError::MathOverflow)?;
    task.state = TaskState::Disputed;
    Ok(())
}

/// Permissionless: no signer is required beyond the transaction fee payer.
#[derive(Accounts)]
pub struct ExpireReview<'info> {
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(
        mut,
        seeds = [TASK_SEED, task.client.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
    )]
    pub task: Box<Account<'info, Task>>,
    #[account(address = platform.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, task.key().as_ref()],
        bump = task.escrow_bump,
        token::mint = usdc_mint,
        token::authority = task,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: only receives the escrow account's rent; pinned to the task's client.
    #[account(mut, address = task.client)]
    pub client: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = task.developer,
    )]
    pub developer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = platform.treasury, token::mint = usdc_mint)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Pays the developer once the review window has passed without a client decision.
pub fn expire_review(ctx: Context<ExpireReview>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    require!(
        task.state == TaskState::UnderReview,
        TaskraError::InvalidState
    );
    require!(
        now > task.review_deadline,
        TaskraError::ReviewDeadlineNotPassed
    );

    Escrow {
        task: &ctx.accounts.task,
        escrow: &ctx.accounts.escrow,
        usdc_mint: &ctx.accounts.usdc_mint,
        client: ctx.accounts.client.to_account_info(),
        token_program: &ctx.accounts.token_program,
    }
    .pay_developer(&ctx.accounts.developer_token, &ctx.accounts.treasury)?;
    finalize(
        &mut ctx.accounts.task,
        TaskState::Settled,
        Outcome::ReviewExpired,
        now,
    );
    Ok(())
}
