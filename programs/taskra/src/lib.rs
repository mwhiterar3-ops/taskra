//! Taskra: USDC task escrow with attested verification and bounded disputes.
//!
//! The lifecycle, account model and security argument are specified in
//! `docs/13-DECISIONS.md`; transition numbers (T1..T16) below refer to §2.3.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod fees;
pub mod instructions;
pub mod settlement;
pub mod state;

use instructions::*;
use state::DisputeResolution;

declare_id!("CCgMR2BZ7Hr4SiMRPYsY6yzZsGgddygjH3eF8A939mkZ");

#[program]
pub mod taskra {
    use super::*;

    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        args: InitializePlatformArgs,
    ) -> Result<()> {
        instructions::platform::initialize_platform(ctx, args)
    }

    pub fn rotate_keys(
        ctx: Context<RotateKeys>,
        new_authority: Pubkey,
        new_attester: Pubkey,
    ) -> Result<()> {
        instructions::platform::rotate_keys(ctx, new_authority, new_attester)
    }

    /// T1
    pub fn create_and_fund_task(
        ctx: Context<CreateAndFundTask>,
        task_id: [u8; 16],
        amount: u64,
        work_duration: i64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create::create_and_fund_task(ctx, task_id, amount, work_duration, terms_hash)
    }

    /// T2
    pub fn cancel_task(ctx: Context<ClientRefund>) -> Result<()> {
        instructions::refund::cancel_task(ctx)
    }

    /// T3
    pub fn accept_task(ctx: Context<AcceptTask>) -> Result<()> {
        instructions::accept::accept_task(ctx)
    }

    /// T4, T5
    pub fn submit_work(ctx: Context<SubmitWork>, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::submit::submit_work(ctx, evidence_hash)
    }

    /// T6
    pub fn record_attestation(
        ctx: Context<RecordAttestation>,
        evidence_hash: [u8; 32],
        submission_nonce: u64,
    ) -> Result<()> {
        instructions::attest::record_attestation(ctx, evidence_hash, submission_nonce)
    }

    /// T7, T8
    pub fn refund_expired(ctx: Context<ClientRefund>) -> Result<()> {
        instructions::refund::refund_expired(ctx)
    }

    /// T9
    pub fn approve_task(ctx: Context<ApproveTask>, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::review::approve_task(ctx, evidence_hash)
    }

    /// T10
    pub fn reject_task(ctx: Context<RejectTask>, reason_hash: [u8; 32]) -> Result<()> {
        instructions::review::reject_task(ctx, reason_hash)
    }

    /// T11
    pub fn expire_review(ctx: Context<ExpireReview>) -> Result<()> {
        instructions::review::expire_review(ctx)
    }

    /// T12
    pub fn open_developer_dispute(ctx: Context<OpenDeveloperDispute>) -> Result<()> {
        instructions::dispute::open_developer_dispute(ctx)
    }

    /// T13, T14
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        resolution: DisputeResolution,
    ) -> Result<()> {
        instructions::dispute::resolve_dispute(ctx, resolution)
    }

    /// T15, T16
    pub fn expire_dispute(ctx: Context<ExpireDispute>) -> Result<()> {
        instructions::dispute::expire_dispute(ctx)
    }
}
