use crate::{
    constants::{BPS_DENOMINATOR, PLATFORM_SEED},
    error::TaskraError,
    program::Taskra,
    state::Platform,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializePlatformArgs {
    pub authority: Pubkey,
    pub attester: Pubkey,
    pub fee_bps: u16,
    pub review_window: i64,
    pub verification_grace: i64,
    pub dispute_timeout: i64,
}

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    /// Must be the program's upgrade authority, so initialization cannot be front-run.
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(
        init,
        payer = upgrade_authority,
        space = 8 + Platform::INIT_SPACE,
        seeds = [PLATFORM_SEED],
        bump,
    )]
    pub platform: Account<'info, Platform>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(token::mint = usdc_mint)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ TaskraError::InvalidUpgradeAuthority,
    )]
    pub program: Program<'info, Taskra>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key())
            @ TaskraError::InvalidUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_platform(
    ctx: Context<InitializePlatform>,
    args: InitializePlatformArgs,
) -> Result<()> {
    require!(args.fee_bps <= BPS_DENOMINATOR, TaskraError::InvalidFeeBps);
    require!(
        args.review_window > 0 && args.verification_grace > 0 && args.dispute_timeout > 0,
        TaskraError::InvalidWindow
    );
    require_keys_separate(
        &args.authority,
        &args.attester,
        &ctx.accounts.treasury.owner,
        Some(ctx.accounts.upgrade_authority.key()),
    )?;

    ctx.accounts.platform.set_inner(Platform {
        authority: args.authority,
        attester: args.attester,
        treasury: ctx.accounts.treasury.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
        fee_bps: args.fee_bps,
        review_window: args.review_window,
        verification_grace: args.verification_grace,
        dispute_timeout: args.dispute_timeout,
        bump: ctx.bumps.platform,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RotateKeys<'info> {
    #[account(address = platform.authority @ TaskraError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(address = platform.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    /// The treasury to use from now on. Pass the current one to keep it.
    #[account(token::mint = usdc_mint)]
    pub new_treasury: Account<'info, TokenAccount>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ TaskraError::InvalidUpgradeAuthority,
    )]
    pub program: Program<'info, Taskra>,
    pub program_data: Account<'info, ProgramData>,
}

/// Replaces the authority, attester and treasury. Pass a current value to keep it.
pub fn rotate_keys(
    ctx: Context<RotateKeys>,
    new_authority: Pubkey,
    new_attester: Pubkey,
) -> Result<()> {
    require_keys_separate(
        &new_authority,
        &new_attester,
        &ctx.accounts.new_treasury.owner,
        ctx.accounts.program_data.upgrade_authority_address,
    )?;

    let platform = &mut ctx.accounts.platform;
    platform.authority = new_authority;
    platform.attester = new_attester;
    platform.treasury = ctx.accounts.new_treasury.key();
    Ok(())
}

fn require_keys_separate(
    authority: &Pubkey,
    attester: &Pubkey,
    treasury_owner: &Pubkey,
    upgrade_authority: Option<Pubkey>,
) -> Result<()> {
    require!(
        authority != attester
            && treasury_owner != authority
            && treasury_owner != attester
            && upgrade_authority != Some(*authority),
        TaskraError::KeysNotSeparate
    );
    Ok(())
}
