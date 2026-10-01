use crate::{
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    state::{Outcome, Platform, Task, TaskState},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
#[instruction(task_id: [u8; 16])]
pub struct CreateAndFundTask<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(address = platform.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, token::mint = usdc_mint, token::authority = client)]
    pub client_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = client,
        space = 8 + Task::INIT_SPACE,
        seeds = [TASK_SEED, client.key().as_ref(), task_id.as_ref()],
        bump,
    )]
    pub task: Box<Account<'info, Task>>,
    #[account(
        init,
        payer = client,
        seeds = [ESCROW_SEED, task.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = task,
    )]
    pub escrow: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Creates the task and moves `amount` into escrow in one instruction. Any
/// failure reverts the whole transaction, so an unfunded task cannot exist.
pub fn create_and_fund_task(
    ctx: Context<CreateAndFundTask>,
    task_id: [u8; 16],
    amount: u64,
    work_duration: i64,
    terms_hash: [u8; 32],
) -> Result<()> {
    require!(amount > 0, TaskraError::InvalidAmount);
    require!(work_duration > 0, TaskraError::InvalidWorkDuration);
    require!(terms_hash != [0u8; 32], TaskraError::ZeroHash);

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.client_token.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.client.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;
    ctx.accounts.escrow.reload()?;
    require!(
        ctx.accounts.escrow.amount == amount,
        TaskraError::EscrowBalanceMismatch
    );

    ctx.accounts.task.set_inner(Task {
        task_id,
        client: ctx.accounts.client.key(),
        developer: Pubkey::default(),
        amount,
        fee_bps: ctx.accounts.platform.fee_bps,
        terms_hash,
        state: TaskState::Open,
        outcome: Outcome::None,
        work_duration,
        created_at: Clock::get()?.unix_timestamp,
        accepted_at: 0,
        work_deadline: 0,
        verification_deadline: 0,
        submission_nonce: 0,
        evidence_hash: [0u8; 32],
        submitted_at: 0,
        dispute_open_at: 0,
        refund_open_at: 0,
        attested_nonce: 0,
        attested_hash: [0u8; 32],
        verified_at: 0,
        review_deadline: 0,
        disputed_at: 0,
        dispute_deadline: 0,
        rejection_reason_hash: [0u8; 32],
        closed_at: 0,
        bump: ctx.bumps.task,
        escrow_bump: ctx.bumps.escrow,
    });
    Ok(())
}
