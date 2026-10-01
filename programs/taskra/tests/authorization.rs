//! Who may call what, and which accounts each instruction accepts: wrong
//! signers, wrong mints, wrong token accounts, third-party destinations, key
//! separation and input validation.

mod common;

use anchor_lang::error::ErrorCode;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use taskra::{
    error::TaskraError,
    instruction,
    state::{DisputeResolution, TaskState},
};

const AMOUNT: u64 = 100 * USDC;

// --- platform initialization ---------------------------------------------

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut env = Env::uninitialized();
    let impostor = env.wallet(0);
    let mut accounts = env.initialize_accounts();
    accounts.upgrade_authority = impostor.pubkey();
    let args = env.default_init_args();

    let result = env.send(
        &[ix(accounts, instruction::InitializePlatform { args })],
        &[&impostor],
    );
    fails_with(result, TaskraError::InvalidUpgradeAuthority);
    assert!(!env.exists(&env.platform));
}

#[test]
fn initialization_fails_when_the_program_has_no_upgrade_authority() {
    let mut env = Env::uninitialized();
    env.set_upgrade_authority(None);
    let (accounts, args) = (env.initialize_accounts(), env.default_init_args());
    fails_with(
        env.initialize(accounts, args),
        TaskraError::InvalidUpgradeAuthority,
    );
}

#[test]
fn initialization_rejects_another_programs_program_data() {
    let mut env = Env::uninitialized();
    let mut accounts = env.initialize_accounts();
    // Any other account owned by the upgradeable loader is not this program's data.
    accounts.program_data = taskra::ID;
    let args = env.default_init_args();
    assert!(env.initialize(accounts, args).is_err());
    assert!(!env.exists(&env.platform));
}

#[test]
fn platform_cannot_be_initialized_twice() {
    let mut env = Env::new();
    let (accounts, mut args) = (env.initialize_accounts(), env.default_init_args());
    args.fee_bps = 9_000;
    assert!(env.initialize(accounts, args).is_err());
    assert_eq!(env.platform_state().fee_bps, FEE_BPS);
}

#[test]
fn initialization_validates_fee_and_windows() {
    let mut env = Env::uninitialized();

    let mut args = env.default_init_args();
    args.fee_bps = 10_001;
    let accounts = env.initialize_accounts();
    fails_with(env.initialize(accounts, args), TaskraError::InvalidFeeBps);

    for field in 0..3 {
        for bad in [0, -1] {
            let mut args = env.default_init_args();
            match field {
                0 => args.review_window = bad,
                1 => args.verification_grace = bad,
                _ => args.dispute_timeout = bad,
            }
            let accounts = env.initialize_accounts();
            fails_with(env.initialize(accounts, args), TaskraError::InvalidWindow);
        }
    }
    assert!(!env.exists(&env.platform));
}

#[test]
fn initialization_requires_separate_keys() {
    let mut env = Env::uninitialized();

    // authority == attester
    let mut args = env.default_init_args();
    args.attester = args.authority;
    let accounts = env.initialize_accounts();
    fails_with(env.initialize(accounts, args), TaskraError::KeysNotSeparate);

    // authority == upgrade authority
    let mut args = env.default_init_args();
    args.authority = env.upgrade_authority.pubkey();
    let accounts = env.initialize_accounts();
    fails_with(env.initialize(accounts, args), TaskraError::KeysNotSeparate);

    // treasury owned by the authority, then by the attester
    for owner in [env.authority.pubkey(), env.attester.pubkey()] {
        let mut accounts = env.initialize_accounts();
        accounts.treasury = env.create_token_account(env.mint, owner, 0);
        let args = env.default_init_args();
        fails_with(env.initialize(accounts, args), TaskraError::KeysNotSeparate);
    }
    assert!(!env.exists(&env.platform));
}

#[test]
fn initialization_rejects_a_treasury_of_another_mint() {
    let mut env = Env::uninitialized();
    let other_mint = env.create_mint();
    let mut accounts = env.initialize_accounts();
    accounts.treasury = env.create_token_account(other_mint, env.treasury_owner.pubkey(), 0);
    let args = env.default_init_args();
    fails_with_anchor(
        env.initialize(accounts, args),
        ErrorCode::ConstraintTokenMint,
    );
}

// --- key rotation --------------------------------------------------------

fn rotate_accounts(
    env: &Env,
    new_treasury: anchor_lang::prelude::Pubkey,
) -> taskra::accounts::RotateKeys {
    taskra::accounts::RotateKeys {
        authority: env.authority.pubkey(),
        platform: env.platform,
        usdc_mint: env.mint,
        new_treasury,
        program: taskra::ID,
        program_data: program_data_address(),
    }
}

#[test]
fn authority_rotates_all_three_keys() {
    let mut env = Env::new();
    let new_authority = env.wallet(0);
    let new_attester = env.wallet(0);
    let new_treasury = env.create_token_account(env.mint, Keypair::new().pubkey(), 0);
    let old_attester = env.attester.insecure_clone();
    let old_authority = env.authority.insecure_clone();

    let t = env.submitted_task(AMOUNT);
    ok(env.send(
        &[ix(
            rotate_accounts(&env, new_treasury),
            instruction::RotateKeys {
                new_authority: new_authority.pubkey(),
                new_attester: new_attester.pubkey(),
            },
        )],
        &[&old_authority],
    ));
    let platform = env.platform_state();
    assert_eq!(platform.authority, new_authority.pubkey());
    assert_eq!(platform.attester, new_attester.pubkey());
    assert_eq!(platform.treasury, new_treasury);

    // The old attester stops working immediately; the new one works.
    let attest = env.attest_ix(&t, &old_attester.pubkey(), EVIDENCE, 1);
    fails_with(
        env.send(&[attest], &[&old_attester]),
        TaskraError::Unauthorized,
    );
    let attest = env.attest_ix(&t, &new_attester.pubkey(), EVIDENCE, 1);
    ok(env.send(&[attest], &[&new_attester]));

    // The old authority can no longer rotate or resolve.
    let again = ix(
        rotate_accounts(&env, new_treasury),
        instruction::RotateKeys {
            new_authority: old_authority.pubkey(),
            new_attester: new_attester.pubkey(),
        },
    );
    assert!(env.send(&[again], &[&old_authority]).is_err());

    // Fees now go to the new treasury; the old one is no longer accepted.
    let stale = env.approve_ix(&t);
    fails_with_anchor(
        env.send(&[stale], &[&t.client]),
        ErrorCode::ConstraintAddress,
    );
    let mut accounts = env.approve_accounts(&t);
    accounts.treasury = new_treasury;
    ok(env.send(
        &[ix(
            accounts,
            instruction::ApproveTask {
                evidence_hash: EVIDENCE,
            },
        )],
        &[&t.client],
    ));
    assert_eq!(env.token_balance(&new_treasury), 2_500_000);
    assert_eq!(env.token_balance(&env.treasury), 0);
}

#[test]
fn only_the_authority_can_rotate_keys() {
    let mut env = Env::new();
    for impostor in [
        env.attester.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        env.wallet(0),
    ] {
        let mut accounts = rotate_accounts(&env, env.treasury);
        accounts.authority = impostor.pubkey();
        let result = env.send(
            &[ix(
                accounts,
                instruction::RotateKeys {
                    new_authority: impostor.pubkey(),
                    new_attester: env.attester.pubkey(),
                },
            )],
            &[&impostor],
        );
        fails_with(result, TaskraError::Unauthorized);
    }
    assert_eq!(env.platform_state().authority, env.authority.pubkey());
}

#[test]
fn rotation_keeps_keys_separate() {
    let mut env = Env::new();
    let authority = env.authority.insecure_clone();
    let attester = env.attester.pubkey();
    let upgrade_authority = env.upgrade_authority.pubkey();
    let treasury_of_attester = env.create_token_account(env.mint, attester, 0);

    let cases = [
        // (new_authority, new_attester, new_treasury)
        (authority.pubkey(), authority.pubkey(), env.treasury),
        (upgrade_authority, attester, env.treasury),
        (authority.pubkey(), attester, treasury_of_attester),
    ];
    for (new_authority, new_attester, new_treasury) in cases {
        let result = env.send(
            &[ix(
                rotate_accounts(&env, new_treasury),
                instruction::RotateKeys {
                    new_authority,
                    new_attester,
                },
            )],
            &[&authority],
        );
        fails_with(result, TaskraError::KeysNotSeparate);
    }
    let platform = env.platform_state();
    assert_eq!(platform.attester, attester);
    assert_eq!(platform.treasury, env.treasury);
}

// --- create and fund -----------------------------------------------------

#[test]
fn create_validates_its_arguments() {
    let mut env = Env::new();
    let client = env.wallet(AMOUNT);
    let cases = [
        (0, WORK_DURATION, TERMS_HASH, TaskraError::InvalidAmount),
        (AMOUNT, 0, TERMS_HASH, TaskraError::InvalidWorkDuration),
        (AMOUNT, -5, TERMS_HASH, TaskraError::InvalidWorkDuration),
        (AMOUNT, WORK_DURATION, [0; 32], TaskraError::ZeroHash),
    ];
    for (amount, duration, terms, error) in cases {
        let task_id = env.next_task_id();
        let create = env.create_ix(&client.pubkey(), task_id, amount, duration, terms);
        fails_with(env.send(&[create], &[&client]), error);
        // Atomic: no task account, no escrow, no funds moved.
        let task = task_address(&client.pubkey(), &task_id);
        assert!(!env.exists(&task));
        assert!(!env.exists(&escrow_address(&task)));
    }
    assert_eq!(env.token_balance(&env.ata(&client.pubkey())), AMOUNT);
}

#[test]
fn create_with_insufficient_funds_leaves_nothing_behind() {
    let mut env = Env::new();
    let client = env.wallet(AMOUNT - 1);
    let task_id = env.next_task_id();
    let create = env.create_ix(&client.pubkey(), task_id, AMOUNT, WORK_DURATION, TERMS_HASH);
    assert!(env.send(&[create], &[&client]).is_err());

    let task = task_address(&client.pubkey(), &task_id);
    assert!(!env.exists(&task));
    assert!(!env.exists(&escrow_address(&task)));
    assert_eq!(env.token_balance(&env.ata(&client.pubkey())), AMOUNT - 1);
}

#[test]
fn a_task_id_cannot_be_reused_by_the_same_client() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    env.create_ata(env.mint, t.client.pubkey(), AMOUNT);
    let create = env.create_ix(
        &t.client.pubkey(),
        t.task_id,
        AMOUNT,
        WORK_DURATION,
        TERMS_HASH,
    );
    assert!(env.send(&[create], &[&t.client]).is_err());
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn create_rejects_the_wrong_mint() {
    let mut env = Env::new();
    let fake_mint = env.create_mint();
    let client = env.wallet(AMOUNT);
    let fake_tokens = env.create_ata(fake_mint, client.pubkey(), AMOUNT);

    // A mint that is not the configured USDC mint.
    let task_id = env.next_task_id();
    let mut accounts = env.create_accounts(&client.pubkey(), &task_id);
    accounts.usdc_mint = fake_mint;
    accounts.client_token = fake_tokens;
    let data = instruction::CreateAndFundTask {
        task_id,
        amount: AMOUNT,
        work_duration: WORK_DURATION,
        terms_hash: TERMS_HASH,
    };
    fails_with_anchor(
        env.send(&[ix(accounts, data)], &[&client]),
        ErrorCode::ConstraintAddress,
    );

    // The right mint but a source account holding a different token.
    let task_id = env.next_task_id();
    let mut accounts = env.create_accounts(&client.pubkey(), &task_id);
    accounts.client_token = fake_tokens;
    let data = instruction::CreateAndFundTask {
        task_id,
        amount: AMOUNT,
        work_duration: WORK_DURATION,
        terms_hash: TERMS_HASH,
    };
    fails_with_anchor(
        env.send(&[ix(accounts, data)], &[&client]),
        ErrorCode::ConstraintTokenMint,
    );
}

#[test]
fn a_client_cannot_fund_a_task_from_someone_elses_token_account() {
    let mut env = Env::new();
    let victim = env.wallet(AMOUNT);
    let client = env.wallet(0);
    let task_id = env.next_task_id();
    let mut accounts = env.create_accounts(&client.pubkey(), &task_id);
    accounts.client_token = env.ata(&victim.pubkey());
    let data = instruction::CreateAndFundTask {
        task_id,
        amount: AMOUNT,
        work_duration: WORK_DURATION,
        terms_hash: TERMS_HASH,
    };
    fails_with_anchor(
        env.send(&[ix(accounts, data)], &[&client]),
        ErrorCode::ConstraintTokenOwner,
    );
    assert_eq!(env.token_balance(&env.ata(&victim.pubkey())), AMOUNT);
}

// --- wrong client --------------------------------------------------------

#[test]
fn only_the_task_client_can_cancel_refund_approve_or_reject() {
    let mut env = Env::new();
    let stranger = env.wallet(0);

    // cancel
    let t = env.open_task(AMOUNT);
    let mut accounts = env.client_refund_accounts(&t);
    accounts.client = stranger.pubkey();
    accounts.client_token = env.ata(&stranger.pubkey());
    fails_with(
        env.send(&[ix(accounts, instruction::CancelTask {})], &[&stranger]),
        TaskraError::Unauthorized,
    );

    // refund_expired, by a stranger and by the developer
    ok(env.accept(&t));
    env.advance(WORK_DURATION + 1);
    for wallet in [&stranger, &t.developer] {
        let mut accounts = env.client_refund_accounts(&t);
        accounts.client = wallet.pubkey();
        accounts.client_token = env.ata(&wallet.pubkey());
        fails_with(
            env.send(&[ix(accounts, instruction::RefundExpired {})], &[wallet]),
            TaskraError::Unauthorized,
        );
    }
    assert_eq!(env.balances(&t).escrow, AMOUNT);

    // approve, by a stranger and by the developer themselves
    let t = env.under_review_task(AMOUNT);
    for wallet in [&stranger, &t.developer] {
        let mut accounts = env.approve_accounts(&t);
        accounts.client = wallet.pubkey();
        let data = instruction::ApproveTask {
            evidence_hash: EVIDENCE,
        };
        fails_with(
            env.send(&[ix(accounts, data)], &[wallet]),
            TaskraError::Unauthorized,
        );
    }

    // reject
    let reject = env.reject_ix(&t, &stranger.pubkey(), REASON);
    fails_with(env.send(&[reject], &[&stranger]), TaskraError::Unauthorized);
    assert_eq!(env.task(&t).state, TaskState::UnderReview);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

// --- wrong developer -----------------------------------------------------

#[test]
fn the_client_cannot_accept_their_own_task() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    let accept = env.accept_ix(&t, &t.client.pubkey());
    fails_with(
        env.send(&[accept], &[&t.client]),
        TaskraError::ClientCannotAccept,
    );
    assert_eq!(env.task(&t).state, TaskState::Open);
}

#[test]
fn only_the_accepted_developer_can_submit_or_escalate() {
    let mut env = Env::new();
    let stranger = env.wallet(0);
    let t = env.accepted_task(AMOUNT);

    for wallet in [&stranger, &t.client] {
        let submit = env.submit_ix(&t, &wallet.pubkey(), EVIDENCE);
        fails_with(env.send(&[submit], &[wallet]), TaskraError::Unauthorized);
    }
    assert_eq!(env.task(&t).state, TaskState::Accepted);

    ok(env.submit(&t, EVIDENCE));
    let open_at = env.task(&t).dispute_open_at;
    env.set_time(open_at + 1);
    for wallet in [&stranger, &t.client] {
        let dispute = env.developer_dispute_ix(&t, &wallet.pubkey());
        fails_with(env.send(&[dispute], &[wallet]), TaskraError::Unauthorized);
    }
    assert_eq!(env.task(&t).state, TaskState::Submitted);
}

#[test]
fn a_second_developer_cannot_take_over_an_accepted_task() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    let other = env.wallet(0);
    let accept = env.accept_ix(&t, &other.pubkey());
    fails_with(env.send(&[accept], &[&other]), TaskraError::InvalidState);
    assert_eq!(env.task(&t).developer, t.developer.pubkey());
}

// --- attester ------------------------------------------------------------

#[test]
fn only_the_configured_attester_can_attest() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let authority = env.authority.insecure_clone();
    let stranger = env.wallet(0);

    for wallet in [&stranger, &t.developer, &t.client, &authority] {
        let attest = env.attest_ix(&t, &wallet.pubkey(), EVIDENCE, 1);
        fails_with(env.send(&[attest], &[wallet]), TaskraError::Unauthorized);
    }
    assert_eq!(env.task(&t).state, TaskState::Submitted);
}

#[test]
fn an_attestation_must_match_the_current_hash_and_nonce() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let attester = env.attester.insecure_clone();

    let wrong_hash = env.attest_ix(&t, &attester.pubkey(), OTHER_EVIDENCE, 1);
    fails_with(
        env.send(&[wrong_hash], &[&attester]),
        TaskraError::EvidenceMismatch,
    );
    for nonce in [0, 2] {
        let wrong_nonce = env.attest_ix(&t, &attester.pubkey(), EVIDENCE, nonce);
        fails_with(
            env.send(&[wrong_nonce], &[&attester]),
            TaskraError::NonceMismatch,
        );
    }
    assert_eq!(env.task(&t).state, TaskState::Submitted);
}

#[test]
fn an_attestation_for_an_earlier_submission_is_stale_after_resubmission() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let attester = env.attester.insecure_clone();
    // The attester signed for submission 1; the developer resubmits first.
    let stale = env.attest_ix(&t, &attester.pubkey(), EVIDENCE, 1);

    // Resubmitting the very same hash still invalidates it: the nonce moved on.
    ok(env.submit(&t, EVIDENCE));
    fails_with(env.send(&[stale], &[&attester]), TaskraError::NonceMismatch);
    assert_eq!(env.task(&t).state, TaskState::Submitted);

    // Resubmitting after an attestation voids it; the old review cannot expire.
    ok(env.attest(&t));
    let review_deadline = env.task(&t).review_deadline;
    ok(env.submit(&t, OTHER_EVIDENCE));
    env.set_time(review_deadline + 1);
    fails_with(env.expire_review(&t), TaskraError::InvalidState);
    let old = env.attest_ix(&t, &attester.pubkey(), EVIDENCE, 2);
    fails_with(env.send(&[old], &[&attester]), TaskraError::NonceMismatch);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn a_stale_approval_fails_after_resubmission() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    // The client reviewed EVIDENCE and builds the approval for it.
    let approval = env.approve_ix(&t);
    ok(env.submit(&t, OTHER_EVIDENCE));
    fails_with(
        env.send(&[approval], &[&t.client]),
        TaskraError::EvidenceMismatch,
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn the_attester_cannot_sign_any_fund_moving_instruction() {
    let mut env = Env::new();
    let attester = env.attester.insecure_clone();
    env.create_ata(env.mint, attester.pubkey(), 0);

    // approve
    let t = env.under_review_task(AMOUNT);
    let mut accounts = env.approve_accounts(&t);
    accounts.client = attester.pubkey();
    let data = instruction::ApproveTask {
        evidence_hash: EVIDENCE,
    };
    fails_with(
        env.send(&[ix(accounts, data)], &[&attester]),
        TaskraError::Unauthorized,
    );

    // cancel / refund
    let mut accounts = env.client_refund_accounts(&t);
    accounts.client = attester.pubkey();
    accounts.client_token = env.ata(&attester.pubkey());
    fails_with(
        env.send(&[ix(accounts, instruction::RefundExpired {})], &[&attester]),
        TaskraError::Unauthorized,
    );

    // resolve a dispute
    ok(env.reject(&t));
    for resolution in [
        DisputeResolution::PayDeveloper,
        DisputeResolution::RefundClient,
    ] {
        let mut accounts = env.resolve_accounts(&t);
        accounts.authority = attester.pubkey();
        fails_with(
            env.send(
                &[ix(accounts, instruction::ResolveDispute { resolution })],
                &[&attester],
            ),
            TaskraError::Unauthorized,
        );
    }
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.token_balance(&env.ata(&attester.pubkey())), 0);
}

// --- dispute resolution --------------------------------------------------

#[test]
fn only_the_authority_can_resolve_a_dispute() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    let stranger = env.wallet(0);
    for wallet in [&stranger, &t.client, &t.developer] {
        for resolution in [
            DisputeResolution::PayDeveloper,
            DisputeResolution::RefundClient,
        ] {
            let mut accounts = env.resolve_accounts(&t);
            accounts.authority = wallet.pubkey();
            fails_with(
                env.send(
                    &[ix(accounts, instruction::ResolveDispute { resolution })],
                    &[wallet],
                ),
                TaskraError::Unauthorized,
            );
        }
    }
    assert_eq!(env.task(&t).state, TaskState::Disputed);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn the_authority_cannot_send_disputed_funds_to_a_third_party() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    let accomplice = env.wallet(0);
    let accomplice_ata = env.ata(&accomplice.pubkey());
    let authority_ata = env.create_ata(env.mint, env.authority.pubkey(), 0);
    // A second, non-associated token account that really is owned by the developer.
    let developer_side_account = env.create_token_account(env.mint, t.developer.pubkey(), 0);
    let client_ata = env.ata(&t.client.pubkey());
    let developer_ata = env.ata(&t.developer.pubkey());

    // "Pay developer" into anything other than the developer's ATA.
    for destination in [
        accomplice_ata,
        authority_ata,
        client_ata,
        developer_side_account,
    ] {
        let mut accounts = env.resolve_accounts(&t);
        accounts.developer_token = Some(destination);
        // Pass each account once, so the destination constraint is what is tested
        // (Anchor separately refuses the same writable account passed twice).
        accounts.client_token = None;
        rejects_destination(env.resolve_with(accounts, DisputeResolution::PayDeveloper));
    }

    // "Refund client" into anything other than the client's ATA.
    for destination in [accomplice_ata, authority_ata, developer_ata] {
        let mut accounts = env.resolve_accounts(&t);
        accounts.client_token = Some(destination);
        accounts.developer_token = None;
        rejects_destination(env.resolve_with(accounts, DisputeResolution::RefundClient));
    }

    // The fee cannot be diverted from the configured treasury either.
    for destination in [accomplice_ata, authority_ata] {
        let mut accounts = env.resolve_accounts(&t);
        accounts.treasury = Some(destination);
        fails_with_anchor(
            env.resolve_with(accounts, DisputeResolution::PayDeveloper),
            ErrorCode::ConstraintAddress,
        );
    }

    // The escrow rent cannot be diverted from the client.
    let mut accounts = env.resolve_accounts(&t);
    accounts.client = accomplice.pubkey();
    fails_with_anchor(
        env.resolve_with(accounts, DisputeResolution::RefundClient),
        ErrorCode::ConstraintAddress,
    );

    assert_eq!(env.task(&t).state, TaskState::Disputed);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    for account in [accomplice_ata, authority_ata, developer_side_account] {
        assert_eq!(env.token_balance(&account), 0);
    }
}

#[test]
fn each_dispute_outcome_requires_its_own_destination_accounts() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);

    let mut accounts = env.resolve_accounts(&t);
    accounts.developer_token = None;
    fails_with(
        env.resolve_with(accounts, DisputeResolution::PayDeveloper),
        TaskraError::MissingOutcomeAccount,
    );
    let mut accounts = env.resolve_accounts(&t);
    accounts.treasury = None;
    fails_with(
        env.resolve_with(accounts, DisputeResolution::PayDeveloper),
        TaskraError::MissingOutcomeAccount,
    );
    let mut accounts = env.resolve_accounts(&t);
    accounts.client_token = None;
    fails_with(
        env.resolve_with(accounts, DisputeResolution::RefundClient),
        TaskraError::MissingOutcomeAccount,
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);

    // A refund needs neither the developer's account nor the treasury.
    let mut accounts = env.resolve_accounts(&t);
    accounts.developer_token = None;
    accounts.treasury = None;
    ok(env.resolve_with(accounts, DisputeResolution::RefundClient));
    assert_eq!(env.balances(&t).client, AMOUNT);
}

// --- wrong token accounts on the permissionless and client paths ---------

#[test]
fn settlement_only_pays_the_recorded_developer_and_treasury() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    let thief = env.wallet(0);
    let thief_ata = env.ata(&thief.pubkey());
    let review_deadline = env.task(&t).review_deadline;
    env.set_time(review_deadline + 1);

    // Permissionless expiry, with the caller trying to redirect each destination.
    let mut accounts = env.expire_review_accounts(&t);
    accounts.developer_token = thief_ata;
    rejects_destination(env.send(&[ix(accounts, instruction::ExpireReview {})], &[&thief]));
    let mut accounts = env.expire_review_accounts(&t);
    accounts.treasury = thief_ata;
    fails_with_anchor(
        env.send(&[ix(accounts, instruction::ExpireReview {})], &[&thief]),
        ErrorCode::ConstraintAddress,
    );
    let mut accounts = env.expire_review_accounts(&t);
    accounts.client = thief.pubkey();
    fails_with_anchor(
        env.send(&[ix(accounts, instruction::ExpireReview {})], &[&thief]),
        ErrorCode::ConstraintAddress,
    );

    // A developer account for a different mint is not accepted either.
    let other_mint = env.create_mint();
    let wrong_mint_ata = env.create_ata(other_mint, t.developer.pubkey(), 0);
    let mut accounts = env.expire_review_accounts(&t);
    accounts.developer_token = wrong_mint_ata;
    rejects_destination(env.send(&[ix(accounts, instruction::ExpireReview {})], &[&thief]));
    let mut accounts = env.expire_review_accounts(&t);
    accounts.usdc_mint = other_mint;
    accounts.developer_token = wrong_mint_ata;
    fails_with_anchor(
        env.send(&[ix(accounts, instruction::ExpireReview {})], &[&thief]),
        ErrorCode::ConstraintAddress,
    );

    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.token_balance(&thief_ata), 0);
}

#[test]
fn the_dispute_fallback_cannot_be_redirected_by_its_caller() {
    let mut env = Env::new();
    let thief = env.wallet(0);
    let thief_ata = env.ata(&thief.pubkey());

    // Attested dispute: the fallback pays the developer, and only the developer.
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    let mut accounts = env.expire_dispute_accounts(&t);
    accounts.developer_token = Some(thief_ata);
    rejects_destination(env.send(&[ix(accounts, instruction::ExpireDispute {})], &[&thief]));
    // Omitting the developer's account cannot flip the outcome to a refund.
    let mut accounts = env.expire_dispute_accounts(&t);
    accounts.developer_token = None;
    accounts.treasury = None;
    fails_with(
        env.send(&[ix(accounts, instruction::ExpireDispute {})], &[&thief]),
        TaskraError::MissingOutcomeAccount,
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);

    // Unattested dispute: the fallback refunds the client, and only the client.
    let t = env.developer_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    let mut accounts = env.expire_dispute_accounts(&t);
    accounts.client_token = Some(thief_ata);
    rejects_destination(env.send(&[ix(accounts, instruction::ExpireDispute {})], &[&thief]));
    // Omitting the client's account cannot flip the outcome to a payment.
    let mut accounts = env.expire_dispute_accounts(&t);
    accounts.client_token = None;
    fails_with(
        env.send(&[ix(accounts, instruction::ExpireDispute {})], &[&thief]),
        TaskraError::MissingOutcomeAccount,
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.token_balance(&thief_ata), 0);
}

#[test]
fn a_refund_cannot_be_sent_to_another_wallet() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    let other = env.wallet(0);
    let mut accounts = env.client_refund_accounts(&t);
    accounts.client_token = env.ata(&other.pubkey());
    rejects_destination(env.send(&[ix(accounts, instruction::CancelTask {})], &[&t.client]));
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn one_tasks_instruction_cannot_drain_another_tasks_escrow() {
    let mut env = Env::new();
    let victim = env.open_task(AMOUNT);
    let attacker = env.open_task(USDC);

    // The attacker cancels their own task but points at the victim's escrow.
    let mut accounts = env.client_refund_accounts(&attacker);
    accounts.escrow = victim.escrow;
    fails_with_anchor(
        env.send(
            &[ix(accounts, instruction::CancelTask {})],
            &[&attacker.client],
        ),
        ErrorCode::ConstraintSeeds,
    );
    assert_eq!(env.balances(&victim).escrow, AMOUNT);
    assert_eq!(env.balances(&attacker).client, 0);
}

#[test]
fn hashes_must_not_be_zero() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    fails_with(env.submit(&t, [0; 32]), TaskraError::ZeroHash);

    let t = env.under_review_task(AMOUNT);
    let reject = env.reject_ix(&t, &t.client.pubkey(), [0; 32]);
    fails_with(env.send(&[reject], &[&t.client]), TaskraError::ZeroHash);
    assert_eq!(env.task(&t).state, TaskState::UnderReview);
}
