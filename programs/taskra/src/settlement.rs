//! The only code that moves funds out of escrow. Every terminal transition
//! goes through `pay_developer` or `refund_client`, which empty the escrow
//! token account and close it, so no second settlement can ever find funds.

use crate::{
    constants::TASK_SEED,
    error::TaskraError,
    fees::compute_fee,
    state::{Outcome, Task, TaskState},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

pub struct Escrow<'a, 'info> {
    pub task: &'a Account<'info, Task>,
    pub escrow: &'a Account<'info, TokenAccount>,
    pub usdc_mint: &'a Account<'info, Mint>,
    /// Receives the escrow account's rent; must be `task.client`.
    pub client: AccountInfo<'info>,
    pub token_program: &'a Program<'info, Token>,
}

impl<'info> Escrow<'_, 'info> {
    fn transfer(&self, to: &Account<'info, TokenAccount>, amount: u64) -> Result<()> {
        let task = self.task;
        let seeds: &[&[u8]] = &[
            TASK_SEED,
            task.client.as_ref(),
            task.task_id.as_ref(),
            &[task.bump],
        ];
        token::transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.key(),
                TransferChecked {
                    from: self.escrow.to_account_info(),
                    mint: self.usdc_mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: task.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            self.usdc_mint.decimals,
        )
    }

    fn close(&self) -> Result<()> {
        let task = self.task;
        let seeds: &[&[u8]] = &[
            TASK_SEED,
            task.client.as_ref(),
            task.task_id.as_ref(),
            &[task.bump],
        ];
        token::close_account(CpiContext::new_with_signer(
            self.token_program.key(),
            CloseAccount {
                account: self.escrow.to_account_info(),
                destination: self.client.clone(),
                authority: task.to_account_info(),
            },
            &[seeds],
        ))
    }

    /// Sends the fee to the treasury and everything else to the developer.
    ///
    /// The fee is computed on `task.amount`; the developer receives the whole
    /// remaining balance so that a stray deposit can never block the close.
    pub fn pay_developer(
        &self,
        developer_token: &Account<'info, TokenAccount>,
        treasury: &Account<'info, TokenAccount>,
    ) -> Result<()> {
        let fee = compute_fee(self.task.amount, self.task.fee_bps)?;
        let remainder = self
            .escrow
            .amount
            .checked_sub(fee)
            .ok_or(TaskraError::MathOverflow)?;
        if fee > 0 {
            self.transfer(treasury, fee)?;
        }
        self.transfer(developer_token, remainder)?;
        self.close()
    }

    /// Returns the whole escrow balance to the client. No fee.
    pub fn refund_client(&self, client_token: &Account<'info, TokenAccount>) -> Result<()> {
        self.transfer(client_token, self.escrow.amount)?;
        self.close()
    }
}

/// Records a terminal state. Callers must have checked the source state.
pub fn finalize(task: &mut Task, state: TaskState, outcome: Outcome, now: i64) {
    task.state = state;
    task.outcome = outcome;
    task.closed_at = now;
}
