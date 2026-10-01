//! Shared LiteSVM harness: a local test mint, clock control, and one helper per
//! instruction. Helpers return the raw transaction result so tests can assert
//! on failures as well as successes.

// Each test binary uses a different subset of the harness, and LiteSVM's own
// result type carries a large error value.
#![allow(dead_code, clippy::result_large_err)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        bpf_loader_upgradeable, clock::Clock, instruction::Instruction, program_option::COption,
        program_pack::Pack,
    },
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::spl_token::state::{Account as SplAccount, AccountState, Mint as SplMint},
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use taskra::{
    accounts,
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
    instruction,
    instructions::InitializePlatformArgs,
    state::{DisputeResolution, Platform, Task},
};

pub const USDC: u64 = 1_000_000;
pub const FEE_BPS: u16 = 250;
pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 24 * HOUR;
pub const REVIEW_WINDOW: i64 = 48 * HOUR;
pub const VERIFICATION_GRACE: i64 = 24 * HOUR;
pub const DISPUTE_TIMEOUT: i64 = 7 * DAY;
pub const WORK_DURATION: i64 = 3 * DAY;
pub const START_TIME: i64 = 1_800_000_000;
pub const TERMS_HASH: [u8; 32] = [7; 32];
pub const EVIDENCE: [u8; 32] = [1; 32];
pub const OTHER_EVIDENCE: [u8; 32] = [2; 32];
pub const REASON: [u8; 32] = [9; 32];

const PROGRAM_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/taskra.so"));

pub struct Env {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub authority: Keypair,
    pub attester: Keypair,
    pub treasury_owner: Keypair,
    /// Pays fees for permissionless instructions; has no role in the program.
    pub cranker: Keypair,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub platform: Pubkey,
    next_task_id: u128,
}

/// One task and the wallets involved in it.
pub struct TaskCtx {
    pub client: Keypair,
    pub developer: Keypair,
    pub task_id: [u8; 16],
    pub task: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Balances {
    pub client: u64,
    pub developer: u64,
    pub treasury: u64,
    pub escrow: u64,
}

pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(taskra::ID, &data.data(), accounts.to_account_metas(None))
}

pub fn task_address(client: &Pubkey, task_id: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(&[TASK_SEED, client.as_ref(), task_id], &taskra::ID).0
}

pub fn escrow_address(task: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_SEED, task.as_ref()], &taskra::ID).0
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[taskra::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

#[track_caller]
pub fn ok(result: TransactionResult) {
    if let Err(failure) = result {
        panic!(
            "transaction failed: {:?}\n{}",
            failure.err,
            failure.meta.pretty_logs()
        );
    }
}

#[track_caller]
fn assert_code(result: TransactionResult, code: u32, name: &str) {
    match result {
        Ok(_) => panic!("expected {name} ({code}) but the transaction succeeded"),
        Err(failure) => {
            let error = format!("{:?}", failure.err);
            assert!(
                error.contains(&format!("Custom({code})")),
                "expected {name} ({code}), got {error}\n{}",
                failure.meta.pretty_logs()
            );
        }
    }
}

#[track_caller]
pub fn fails_with(result: TransactionResult, error: TaskraError) {
    let name = format!("{error:?}");
    assert_code(result, error.into(), &name);
}

#[track_caller]
pub fn fails_with_anchor(result: TransactionResult, error: anchor_lang::error::ErrorCode) {
    let name = format!("{error:?}");
    assert_code(result, error.into(), &name);
}

/// Asserts that a destination token account was refused by its account
/// constraint. Anchor checks an associated token account's owner, then its
/// mint, then its address, so which of the three fires depends on the account.
#[track_caller]
pub fn rejects_destination(result: TransactionResult) {
    use anchor_lang::error::ErrorCode::{
        ConstraintAssociated, ConstraintTokenMint, ConstraintTokenOwner,
    };
    match result {
        Ok(_) => panic!("a wrong destination account was accepted"),
        Err(failure) => {
            let error = format!("{:?}", failure.err);
            let refused = [
                ConstraintTokenOwner,
                ConstraintTokenMint,
                ConstraintAssociated,
            ]
            .into_iter()
            .any(|code| error.contains(&format!("Custom({})", u32::from(code))));
            assert!(
                refused,
                "expected a destination constraint violation, got {error}\n{}",
                failure.meta.pretty_logs()
            );
        }
    }
}

impl Env {
    /// Deploys the program, creates the test mint and treasury, and initializes
    /// the platform with the production defaults (2.5%, 48h, 24h, 7d).
    pub fn new() -> Self {
        let mut env = Self::uninitialized();
        let args = env.default_init_args();
        let accounts = env.initialize_accounts();
        ok(env.initialize(accounts, args));
        env
    }

    /// Everything except `initialize_platform`.
    pub fn uninitialized() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(taskra::ID, PROGRAM_BYTES).unwrap();

        let mut env = Self {
            svm,
            upgrade_authority: Keypair::new(),
            authority: Keypair::new(),
            attester: Keypair::new(),
            treasury_owner: Keypair::new(),
            cranker: Keypair::new(),
            mint: Pubkey::default(),
            treasury: Pubkey::default(),
            platform: Pubkey::find_program_address(&[PLATFORM_SEED], &taskra::ID).0,
            next_task_id: 1,
        };
        env.set_time(START_TIME);
        env.set_upgrade_authority(Some(env.upgrade_authority.pubkey()));
        for wallet in [
            env.upgrade_authority.pubkey(),
            env.authority.pubkey(),
            env.attester.pubkey(),
            env.cranker.pubkey(),
        ] {
            env.svm.airdrop(&wallet, 10_000_000_000).unwrap();
        }
        env.mint = env.create_mint();
        env.treasury = env.create_token_account(env.mint, env.treasury_owner.pubkey(), 0);
        env
    }

    pub fn default_init_args(&self) -> InitializePlatformArgs {
        InitializePlatformArgs {
            authority: self.authority.pubkey(),
            attester: self.attester.pubkey(),
            fee_bps: FEE_BPS,
            review_window: REVIEW_WINDOW,
            verification_grace: VERIFICATION_GRACE,
            dispute_timeout: DISPUTE_TIMEOUT,
        }
    }

    pub fn initialize_accounts(&self) -> accounts::InitializePlatform {
        accounts::InitializePlatform {
            upgrade_authority: self.upgrade_authority.pubkey(),
            platform: self.platform,
            usdc_mint: self.mint,
            treasury: self.treasury,
            program: taskra::ID,
            program_data: program_data_address(),
            system_program: anchor_lang::system_program::ID,
        }
    }

    pub fn initialize(
        &mut self,
        accounts: accounts::InitializePlatform,
        args: InitializePlatformArgs,
    ) -> TransactionResult {
        let signer = self.upgrade_authority.insecure_clone();
        self.send(
            &[ix(accounts, instruction::InitializePlatform { args })],
            &[&signer],
        )
    }

    /// Rewrites the upgrade authority recorded in the program's ProgramData account.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let address = program_data_address();
        let mut account = self.svm.get_account(&address).unwrap();
        // Layout: u32 variant, u64 slot, Option<Pubkey> (1-byte tag + 32 bytes).
        match authority {
            Some(key) => {
                account.data[12] = 1;
                account.data[13..45].copy_from_slice(key.as_ref());
            }
            None => account.data[12..45].fill(0),
        }
        self.svm.set_account(address, account).unwrap();
    }

    // --- clock -----------------------------------------------------------

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    pub fn advance(&mut self, seconds: i64) {
        self.set_time(self.now() + seconds);
    }

    // --- token fixtures --------------------------------------------------

    pub fn create_mint(&mut self) -> Pubkey {
        let address = Pubkey::new_unique();
        let mut data = vec![0; SplMint::LEN];
        SplMint {
            mint_authority: COption::None,
            supply: u64::MAX,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.set_token_program_account(address, data);
        address
    }

    /// Creates a token account at a fresh, non-associated address.
    pub fn create_token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        self.write_token_account(address, mint, owner, amount);
        address
    }

    /// Creates (or overwrites) the owner's associated token account.
    pub fn create_ata(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = get_associated_token_address(&owner, &mint);
        self.write_token_account(address, mint, owner, amount);
        address
    }

    /// Overwrites the USDC token account at `address`, e.g. to simulate a stray deposit.
    pub fn create_token_account_at(&mut self, address: Pubkey, owner: Pubkey, amount: u64) {
        self.write_token_account(address, self.mint, owner, amount);
    }

    fn write_token_account(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let mut data = vec![0; SplAccount::LEN];
        SplAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.set_token_program_account(address, data);
    }

    fn set_token_program_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner: anchor_spl::token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// A wallet with SOL for fees and a USDC associated token account.
    pub fn wallet(&mut self, usdc: u64) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
        self.create_ata(self.mint, wallet.pubkey(), usdc);
        wallet
    }

    pub fn ata(&self, wallet: &Pubkey) -> Pubkey {
        get_associated_token_address(wallet, &self.mint)
    }

    /// Token balance, or zero when the account does not exist (e.g. closed escrow).
    pub fn token_balance(&self, address: &Pubkey) -> u64 {
        match self.svm.get_account(address) {
            Some(account) if account.data.len() == SplAccount::LEN => {
                SplAccount::unpack(&account.data).unwrap().amount
            }
            _ => 0,
        }
    }

    pub fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .is_some_and(|account| account.lamports > 0)
    }

    pub fn balances(&self, t: &TaskCtx) -> Balances {
        Balances {
            client: self.token_balance(&self.ata(&t.client.pubkey())),
            developer: self.token_balance(&self.ata(&t.developer.pubkey())),
            treasury: self.token_balance(&self.treasury),
            escrow: self.token_balance(&t.escrow),
        }
    }

    // --- state readers ---------------------------------------------------

    pub fn task(&self, t: &TaskCtx) -> Task {
        let account = self.svm.get_account(&t.task).expect("task account");
        Task::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn platform_state(&self) -> Platform {
        let account = self.svm.get_account(&self.platform).expect("platform");
        Platform::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    // --- transactions ----------------------------------------------------

    /// Sends one transaction. The first signer pays the fee.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> TransactionResult {
        // A fresh blockhash keeps otherwise identical transactions distinct.
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&signers[0].pubkey()),
            &self.svm.latest_blockhash(),
        );
        let transaction =
            VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        self.svm.send_transaction(transaction)
    }

    fn crank(&mut self, instruction: Instruction) -> TransactionResult {
        let cranker = self.cranker.insecure_clone();
        self.send(&[instruction], &[&cranker])
    }

    // --- create ----------------------------------------------------------

    pub fn next_task_id(&mut self) -> [u8; 16] {
        let id = self.next_task_id;
        self.next_task_id += 1;
        id.to_be_bytes()
    }

    pub fn create_accounts(
        &self,
        client: &Pubkey,
        task_id: &[u8; 16],
    ) -> accounts::CreateAndFundTask {
        let task = task_address(client, task_id);
        accounts::CreateAndFundTask {
            client: *client,
            platform: self.platform,
            usdc_mint: self.mint,
            client_token: self.ata(client),
            task,
            escrow: escrow_address(&task),
            token_program: anchor_spl::token::ID,
            system_program: anchor_lang::system_program::ID,
        }
    }

    pub fn create_ix(
        &self,
        client: &Pubkey,
        task_id: [u8; 16],
        amount: u64,
        work_duration: i64,
        terms_hash: [u8; 32],
    ) -> Instruction {
        ix(
            self.create_accounts(client, &task_id),
            instruction::CreateAndFundTask {
                task_id,
                amount,
                work_duration,
                terms_hash,
            },
        )
    }

    /// A funded, `OPEN` task with a fresh client and developer.
    pub fn open_task(&mut self, amount: u64) -> TaskCtx {
        let client = self.wallet(amount);
        let developer = self.wallet(0);
        let task_id = self.next_task_id();
        let instruction =
            self.create_ix(&client.pubkey(), task_id, amount, WORK_DURATION, TERMS_HASH);
        ok(self.send(&[instruction], &[&client]));
        let task = task_address(&client.pubkey(), &task_id);
        TaskCtx {
            client,
            developer,
            task_id,
            task,
            escrow: escrow_address(&task),
            amount,
        }
    }

    // --- per-instruction helpers ----------------------------------------

    pub fn accept_ix(&self, t: &TaskCtx, developer: &Pubkey) -> Instruction {
        ix(
            accounts::AcceptTask {
                developer: *developer,
                platform: self.platform,
                task: t.task,
            },
            instruction::AcceptTask {},
        )
    }

    pub fn accept(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.accept_ix(t, &t.developer.pubkey());
        self.send(&[instruction], &[&t.developer])
    }

    pub fn submit_ix(
        &self,
        t: &TaskCtx,
        developer: &Pubkey,
        evidence_hash: [u8; 32],
    ) -> Instruction {
        ix(
            accounts::SubmitWork {
                developer: *developer,
                platform: self.platform,
                task: t.task,
            },
            instruction::SubmitWork { evidence_hash },
        )
    }

    pub fn submit(&mut self, t: &TaskCtx, evidence_hash: [u8; 32]) -> TransactionResult {
        let instruction = self.submit_ix(t, &t.developer.pubkey(), evidence_hash);
        self.send(&[instruction], &[&t.developer])
    }

    pub fn attest_ix(
        &self,
        t: &TaskCtx,
        attester: &Pubkey,
        evidence_hash: [u8; 32],
        submission_nonce: u64,
    ) -> Instruction {
        ix(
            accounts::RecordAttestation {
                attester: *attester,
                platform: self.platform,
                task: t.task,
            },
            instruction::RecordAttestation {
                evidence_hash,
                submission_nonce,
            },
        )
    }

    /// Attests the task's current submission with the configured attester.
    pub fn attest(&mut self, t: &TaskCtx) -> TransactionResult {
        let task = self.task(t);
        let attester = self.attester.insecure_clone();
        let instruction = self.attest_ix(
            t,
            &attester.pubkey(),
            task.evidence_hash,
            task.submission_nonce,
        );
        self.send(&[instruction], &[&attester])
    }

    pub fn approve_accounts(&self, t: &TaskCtx) -> accounts::ApproveTask {
        accounts::ApproveTask {
            client: t.client.pubkey(),
            platform: self.platform,
            task: t.task,
            usdc_mint: self.mint,
            escrow: t.escrow,
            developer_token: self.ata(&t.developer.pubkey()),
            treasury: self.treasury,
            token_program: anchor_spl::token::ID,
        }
    }

    pub fn approve_ix(&self, t: &TaskCtx) -> Instruction {
        ix(
            self.approve_accounts(t),
            instruction::ApproveTask {
                evidence_hash: self.task(t).evidence_hash,
            },
        )
    }

    /// Approves the task's current evidence as the client.
    pub fn approve(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.approve_ix(t);
        self.send(&[instruction], &[&t.client])
    }

    pub fn reject_ix(&self, t: &TaskCtx, client: &Pubkey, reason_hash: [u8; 32]) -> Instruction {
        ix(
            accounts::RejectTask {
                client: *client,
                platform: self.platform,
                task: t.task,
            },
            instruction::RejectTask { reason_hash },
        )
    }

    pub fn reject(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.reject_ix(t, &t.client.pubkey(), REASON);
        self.send(&[instruction], &[&t.client])
    }

    pub fn developer_dispute_ix(&self, t: &TaskCtx, developer: &Pubkey) -> Instruction {
        ix(
            accounts::OpenDeveloperDispute {
                developer: *developer,
                platform: self.platform,
                task: t.task,
            },
            instruction::OpenDeveloperDispute {},
        )
    }

    pub fn developer_dispute(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.developer_dispute_ix(t, &t.developer.pubkey());
        self.send(&[instruction], &[&t.developer])
    }

    pub fn expire_review_accounts(&self, t: &TaskCtx) -> accounts::ExpireReview {
        accounts::ExpireReview {
            platform: self.platform,
            task: t.task,
            usdc_mint: self.mint,
            escrow: t.escrow,
            client: t.client.pubkey(),
            developer_token: self.ata(&t.developer.pubkey()),
            treasury: self.treasury,
            token_program: anchor_spl::token::ID,
        }
    }

    pub fn expire_review_ix(&self, t: &TaskCtx) -> Instruction {
        ix(self.expire_review_accounts(t), instruction::ExpireReview {})
    }

    pub fn expire_review(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.expire_review_ix(t);
        self.crank(instruction)
    }

    pub fn client_refund_accounts(&self, t: &TaskCtx) -> accounts::ClientRefund {
        accounts::ClientRefund {
            client: t.client.pubkey(),
            platform: self.platform,
            task: t.task,
            usdc_mint: self.mint,
            escrow: t.escrow,
            client_token: self.ata(&t.client.pubkey()),
            token_program: anchor_spl::token::ID,
        }
    }

    pub fn cancel_ix(&self, t: &TaskCtx) -> Instruction {
        ix(self.client_refund_accounts(t), instruction::CancelTask {})
    }

    pub fn cancel(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.cancel_ix(t);
        self.send(&[instruction], &[&t.client])
    }

    pub fn refund_expired_ix(&self, t: &TaskCtx) -> Instruction {
        ix(
            self.client_refund_accounts(t),
            instruction::RefundExpired {},
        )
    }

    pub fn refund_expired(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.refund_expired_ix(t);
        self.send(&[instruction], &[&t.client])
    }

    pub fn resolve_accounts(&self, t: &TaskCtx) -> accounts::ResolveDispute {
        accounts::ResolveDispute {
            authority: self.authority.pubkey(),
            platform: self.platform,
            task: t.task,
            usdc_mint: self.mint,
            escrow: t.escrow,
            client: t.client.pubkey(),
            client_token: Some(self.ata(&t.client.pubkey())),
            developer_token: Some(self.ata(&t.developer.pubkey())),
            treasury: Some(self.treasury),
            token_program: anchor_spl::token::ID,
        }
    }

    pub fn resolve_with(
        &mut self,
        accounts: accounts::ResolveDispute,
        resolution: DisputeResolution,
    ) -> TransactionResult {
        let authority = self.authority.insecure_clone();
        self.send(
            &[ix(accounts, instruction::ResolveDispute { resolution })],
            &[&authority],
        )
    }

    pub fn resolve(&mut self, t: &TaskCtx, resolution: DisputeResolution) -> TransactionResult {
        let accounts = self.resolve_accounts(t);
        self.resolve_with(accounts, resolution)
    }

    pub fn expire_dispute_accounts(&self, t: &TaskCtx) -> accounts::ExpireDispute {
        accounts::ExpireDispute {
            platform: self.platform,
            task: t.task,
            usdc_mint: self.mint,
            escrow: t.escrow,
            client: t.client.pubkey(),
            client_token: Some(self.ata(&t.client.pubkey())),
            developer_token: Some(self.ata(&t.developer.pubkey())),
            treasury: Some(self.treasury),
            token_program: anchor_spl::token::ID,
        }
    }

    pub fn expire_dispute_ix(&self, t: &TaskCtx) -> Instruction {
        ix(
            self.expire_dispute_accounts(t),
            instruction::ExpireDispute {},
        )
    }

    pub fn expire_dispute(&mut self, t: &TaskCtx) -> TransactionResult {
        let instruction = self.expire_dispute_ix(t);
        self.crank(instruction)
    }

    // --- scenarios: drive a fresh task to a given state -----------------

    pub fn accepted_task(&mut self, amount: u64) -> TaskCtx {
        let t = self.open_task(amount);
        ok(self.accept(&t));
        t
    }

    /// Submitted one hour after acceptance.
    pub fn submitted_task(&mut self, amount: u64) -> TaskCtx {
        let t = self.accepted_task(amount);
        self.advance(HOUR);
        ok(self.submit(&t, EVIDENCE));
        t
    }

    /// Attested one hour after submission.
    pub fn under_review_task(&mut self, amount: u64) -> TaskCtx {
        let t = self.submitted_task(amount);
        self.advance(HOUR);
        ok(self.attest(&t));
        t
    }

    /// Verified work rejected by the client: a dispute with a valid attestation.
    pub fn client_disputed_task(&mut self, amount: u64) -> TaskCtx {
        let t = self.under_review_task(amount);
        self.advance(HOUR);
        ok(self.reject(&t));
        t
    }

    /// Never-verified work escalated by the developer: a dispute with no attestation.
    pub fn developer_disputed_task(&mut self, amount: u64) -> TaskCtx {
        let t = self.submitted_task(amount);
        let open_at = self.task(&t).dispute_open_at;
        self.set_time(open_at + 1);
        ok(self.developer_dispute(&t));
        t
    }
}
