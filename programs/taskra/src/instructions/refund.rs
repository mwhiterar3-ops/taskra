use crate::{
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    settlement::{finalize, Escrow},
    state::{Outcome, Platform, Task, TaskState},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// Accounts for the two client-signed refunds: `cancel_task` and `refund_expired`.
#[derive(Accounts)]
pub struct ClientRefund<'info> {
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
        associated_token::authority = client,
    )]
    pub client_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ClientRefund<'info> {
    fn refund(&mut self, outcome: Outcome, state: TaskState, now: i64) -> Result<()> {
        Escrow {
            task: &self.task,
            escrow: &self.escrow,
            usdc_mint: &self.usdc_mint,
            client: self.client.to_account_info(),
            token_program: &self.token_program,
        }
        .refund_client(&self.client_token)?;
        finalize(&mut self.task, state, outcome, now);
        Ok(())
    }
}

/// The client withdraws a task nobody has accepted.
pub fn cancel_task(ctx: Context<ClientRefund>) -> Result<()> {
    require!(
        ctx.accounts.task.state == TaskState::Open,
        TaskraError::InvalidState
    );
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts
        .refund(Outcome::Cancelled, TaskState::Cancelled, now)
}

/// The client reclaims escrow when the developer missed the work deadline, or
/// when a submission was never verified and the developer did not escalate.
pub fn refund_expired(ctx: Context<ClientRefund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    let outcome = match task.state {
        TaskState::Accepted => {
            require!(now > task.work_deadline, TaskraError::RefundNotOpen);
            Outcome::WorkDeadlineMissed
        }
        TaskState::Submitted => {
            require!(now > task.refund_open_at, TaskraError::RefundNotOpen);
            Outcome::NeverVerified
        }
        _ => return err!(TaskraError::InvalidState),
    };
    ctx.accounts.refund(outcome, TaskState::Refunded, now)
}
