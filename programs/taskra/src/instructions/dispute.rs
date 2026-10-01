use crate::{
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    settlement::{finalize, Escrow},
    state::{DisputeResolution, Outcome, Platform, Task, TaskState},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct OpenDeveloperDispute<'info> {
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

/// The developer escalates a submission that was never verified and that the
/// client never acted on. Moves no funds.
pub fn open_developer_dispute(ctx: Context<OpenDeveloperDispute>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(
        task.state == TaskState::Submitted,
        TaskraError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now > task.dispute_open_at,
        TaskraError::DisputeWindowNotOpen
    );
    require!(now <= task.refund_open_at, TaskraError::DisputeWindowClosed);

    task.disputed_at = now;
    task.dispute_deadline = now
        .checked_add(ctx.accounts.platform.dispute_timeout)
        .ok_or(TaskraError::MathOverflow)?;
    task.state = TaskState::Disputed;
    Ok(())
}

// `ResolveDispute` and `ExpireDispute` pin every destination to the task's
// recorded client or developer, or to the platform treasury; the caller cannot
// choose where funds go. Destinations are optional so that the refund branch
// never depends on the developer's or the treasury's account, and vice versa.

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(address = platform.authority @ TaskraError::Unauthorized)]
    pub authority: Signer<'info>,
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
        associated_token::authority = task.client,
    )]
    pub client_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = task.developer,
    )]
    pub developer_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, address = platform.treasury, token::mint = usdc_mint)]
    pub treasury: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless: no signer is required beyond the transaction fee payer.
#[derive(Accounts)]
pub struct ExpireDispute<'info> {
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
        associated_token::authority = task.client,
    )]
    pub client_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = task.developer,
    )]
    pub developer_token: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, address = platform.treasury, token::mint = usdc_mint)]
    pub treasury: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
}

type OptionalToken<'info> = Option<Box<Account<'info, TokenAccount>>>;

/// Empties the escrow to the developer (minus fee) or to the client, and
/// returns the terminal state that was reached.
fn settle<'info>(
    escrow: Escrow<'_, 'info>,
    pay_developer: bool,
    client_token: &OptionalToken<'info>,
    developer_token: &OptionalToken<'info>,
    treasury: &OptionalToken<'info>,
) -> Result<TaskState> {
    if pay_developer {
        let developer_token = developer_token
            .as_ref()
            .ok_or(TaskraError::MissingOutcomeAccount)?;
        let treasury = treasury
            .as_ref()
            .ok_or(TaskraError::MissingOutcomeAccount)?;
        escrow.pay_developer(developer_token, treasury)?;
        Ok(TaskState::Settled)
    } else {
        let client_token = client_token
            .as_ref()
            .ok_or(TaskraError::MissingOutcomeAccount)?;
        escrow.refund_client(client_token)?;
        Ok(TaskState::Refunded)
    }
}

/// The platform authority decides a dispute before its deadline.
pub fn resolve_dispute(ctx: Context<ResolveDispute>, resolution: DisputeResolution) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    require!(task.state == TaskState::Disputed, TaskraError::InvalidState);
    require!(
        now <= task.dispute_deadline,
        TaskraError::DisputeDeadlinePassed
    );

    let (pay_developer, outcome) = match resolution {
        DisputeResolution::PayDeveloper => (true, Outcome::DisputeResolvedForDeveloper),
        DisputeResolution::RefundClient => (false, Outcome::DisputeResolvedForClient),
    };
    let accounts = &mut *ctx.accounts;
    let state = settle(
        Escrow {
            task: &accounts.task,
            escrow: &accounts.escrow,
            usdc_mint: &accounts.usdc_mint,
            client: accounts.client.to_account_info(),
            token_program: &accounts.token_program,
        },
        pay_developer,
        &accounts.client_token,
        &accounts.developer_token,
        &accounts.treasury,
    )?;
    finalize(&mut accounts.task, state, outcome, now);
    Ok(())
}

/// After the dispute deadline anyone may settle: the developer is paid only if
/// the current submission carries a valid attestation; otherwise the client is
/// refunded. The branch depends on task state alone.
pub fn expire_dispute(ctx: Context<ExpireDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    require!(task.state == TaskState::Disputed, TaskraError::InvalidState);
    require!(
        now > task.dispute_deadline,
        TaskraError::DisputeDeadlineNotPassed
    );

    let (pay_developer, outcome) = if task.has_valid_attestation() {
        (true, Outcome::DisputeExpiredForDeveloper)
    } else {
        (false, Outcome::DisputeExpiredForClient)
    };
    let accounts = &mut *ctx.accounts;
    let state = settle(
        Escrow {
            task: &accounts.task,
            escrow: &accounts.escrow,
            usdc_mint: &accounts.usdc_mint,
            client: accounts.client.to_account_info(),
            token_program: &accounts.token_program,
        },
        pay_developer,
        &accounts.client_token,
        &accounts.developer_token,
        &accounts.treasury,
    )?;
    finalize(&mut accounts.task, state, outcome, now);
    Ok(())
}
