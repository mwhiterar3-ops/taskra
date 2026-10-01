//! Every transition in docs/13-DECISIONS.md §2.3 on its intended path, with
//! exact fund movements.

mod common;

use common::*;
use solana_signer::Signer;
use taskra::state::{DisputeResolution, Outcome, TaskState};

const AMOUNT: u64 = 100 * USDC;
const FEE: u64 = 2_500_000;

fn paid_to_developer(amount: u64, fee: u64) -> Balances {
    Balances {
        client: 0,
        developer: amount - fee,
        treasury: fee,
        escrow: 0,
    }
}

fn refunded_to_client(amount: u64) -> Balances {
    Balances {
        client: amount,
        developer: 0,
        treasury: 0,
        escrow: 0,
    }
}

#[test]
fn initialize_platform_stores_configuration() {
    let env = Env::new();
    let platform = env.platform_state();
    assert_eq!(platform.authority, env.authority.pubkey());
    assert_eq!(platform.attester, env.attester.pubkey());
    assert_eq!(platform.treasury, env.treasury);
    assert_eq!(platform.usdc_mint, env.mint);
    assert_eq!(platform.fee_bps, FEE_BPS);
    assert_eq!(platform.review_window, REVIEW_WINDOW);
    assert_eq!(platform.verification_grace, VERIFICATION_GRACE);
    assert_eq!(platform.dispute_timeout, DISPUTE_TIMEOUT);
}

#[test]
fn create_and_fund_moves_the_amount_into_escrow() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);

    assert_eq!(
        env.balances(&t),
        Balances {
            client: 0,
            developer: 0,
            treasury: 0,
            escrow: AMOUNT
        }
    );
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Open);
    assert_eq!(task.outcome, Outcome::None);
    assert_eq!(task.task_id, t.task_id);
    assert_eq!(task.client, t.client.pubkey());
    assert_eq!(task.amount, AMOUNT);
    assert_eq!(task.fee_bps, FEE_BPS);
    assert_eq!(task.terms_hash, TERMS_HASH);
    assert_eq!(task.work_duration, WORK_DURATION);
    assert_eq!(task.created_at, START_TIME);
    assert_eq!(task.submission_nonce, 0);
}

#[test]
fn accept_records_the_developer_and_deadlines() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    env.advance(HOUR);
    ok(env.accept(&t));

    let task = env.task(&t);
    let accepted_at = START_TIME + HOUR;
    assert_eq!(task.state, TaskState::Accepted);
    assert_eq!(task.developer, t.developer.pubkey());
    assert_eq!(task.accepted_at, accepted_at);
    assert_eq!(task.work_deadline, accepted_at + WORK_DURATION);
    assert_eq!(
        task.verification_deadline,
        accepted_at + WORK_DURATION + VERIFICATION_GRACE
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn submit_records_evidence_and_escalation_windows() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);

    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Submitted);
    assert_eq!(task.evidence_hash, EVIDENCE);
    assert_eq!(task.submission_nonce, 1);
    assert_eq!(task.submitted_at, START_TIME + HOUR);
    // Submitted early, so the verification deadline is the later bound.
    assert_eq!(task.dispute_open_at, task.verification_deadline);
    assert_eq!(task.refund_open_at, task.dispute_open_at + REVIEW_WINDOW);
    assert!(!task.has_valid_attestation());
}

#[test]
fn late_submission_opens_the_dispute_window_a_full_review_window_later() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    let work_deadline = env.task(&t).work_deadline;
    env.set_time(work_deadline);
    ok(env.submit(&t, EVIDENCE));

    let task = env.task(&t);
    assert_eq!(task.dispute_open_at, work_deadline + REVIEW_WINDOW);
    assert!(task.dispute_open_at > task.verification_deadline);
    assert_eq!(task.refund_open_at, work_deadline + 2 * REVIEW_WINDOW);
}

#[test]
fn attestation_starts_the_review_window() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);

    let task = env.task(&t);
    let verified_at = START_TIME + 2 * HOUR;
    assert_eq!(task.state, TaskState::UnderReview);
    assert_eq!(task.verified_at, verified_at);
    assert_eq!(task.attested_hash, EVIDENCE);
    assert_eq!(task.attested_nonce, 1);
    assert_eq!(task.review_deadline, verified_at + REVIEW_WINDOW);
    assert!(task.has_valid_attestation());
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn approval_pays_the_developer_minus_the_fee() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    env.advance(HOUR);
    ok(env.approve(&t));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    assert_eq!(env.balances(&t).developer, 97_500_000);
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Settled);
    assert_eq!(task.outcome, Outcome::Approved);
    assert_eq!(task.closed_at, env.now());
    // The escrow account is gone; the task account remains as the work record.
    assert!(!env.exists(&t.escrow));
    assert!(env.exists(&t.task));
}

#[test]
fn client_may_approve_a_submission_that_was_never_attested() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    ok(env.approve(&t));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    assert_eq!(env.task(&t).outcome, Outcome::Approved);
}

#[test]
fn cancel_before_acceptance_refunds_in_full() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    ok(env.cancel(&t));

    assert_eq!(env.balances(&t), refunded_to_client(AMOUNT));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Cancelled);
    assert_eq!(task.outcome, Outcome::Cancelled);
    assert!(!env.exists(&t.escrow));
}

#[test]
fn review_expiry_pays_the_developer_without_any_privileged_signer() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    let review_deadline = env.task(&t).review_deadline;
    env.set_time(review_deadline + 1);
    ok(env.expire_review(&t));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Settled);
    assert_eq!(task.outcome, Outcome::ReviewExpired);
}

#[test]
fn rejection_opens_a_dispute_and_moves_no_funds() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);

    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Disputed);
    assert_eq!(task.rejection_reason_hash, REASON);
    assert_eq!(task.disputed_at, env.now());
    assert_eq!(task.dispute_deadline, env.now() + DISPUTE_TIMEOUT);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn authority_resolves_a_dispute_for_the_developer() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    ok(env.resolve(&t, DisputeResolution::PayDeveloper));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Settled);
    assert_eq!(task.outcome, Outcome::DisputeResolvedForDeveloper);
}

#[test]
fn authority_resolves_a_dispute_for_the_client() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    ok(env.resolve(&t, DisputeResolution::RefundClient));

    assert_eq!(env.balances(&t), refunded_to_client(AMOUNT));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Refunded);
    assert_eq!(task.outcome, Outcome::DisputeResolvedForClient);
}

#[test]
fn dispute_timeout_pays_the_developer_when_the_work_was_attested() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    let dispute_deadline = env.task(&t).dispute_deadline;
    env.set_time(dispute_deadline + 1);
    ok(env.expire_dispute(&t));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Settled);
    assert_eq!(task.outcome, Outcome::DisputeExpiredForDeveloper);
}

#[test]
fn developer_dispute_then_timeout_refunds_the_client() {
    let mut env = Env::new();
    let t = env.developer_disputed_task(AMOUNT);
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Disputed);
    assert!(!task.has_valid_attestation());
    assert_eq!(env.balances(&t).escrow, AMOUNT);

    env.set_time(task.dispute_deadline + 1);
    ok(env.expire_dispute(&t));

    assert_eq!(env.balances(&t), refunded_to_client(AMOUNT));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Refunded);
    assert_eq!(task.outcome, Outcome::DisputeExpiredForClient);
}

#[test]
fn authority_may_pay_the_developer_after_a_developer_dispute() {
    let mut env = Env::new();
    let t = env.developer_disputed_task(AMOUNT);
    ok(env.resolve(&t, DisputeResolution::PayDeveloper));

    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeResolvedForDeveloper);
}

#[test]
fn missed_work_deadline_refunds_the_client() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    let work_deadline = env.task(&t).work_deadline;
    env.set_time(work_deadline + 1);
    ok(env.refund_expired(&t));

    assert_eq!(env.balances(&t), refunded_to_client(AMOUNT));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Refunded);
    assert_eq!(task.outcome, Outcome::WorkDeadlineMissed);
}

#[test]
fn never_verified_submission_refunds_the_client_after_the_developer_window() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let refund_open_at = env.task(&t).refund_open_at;
    env.set_time(refund_open_at + 1);
    ok(env.refund_expired(&t));

    assert_eq!(env.balances(&t), refunded_to_client(AMOUNT));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Refunded);
    assert_eq!(task.outcome, Outcome::NeverVerified);
}

#[test]
fn resubmission_starts_a_new_nonce_and_voids_the_attestation() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    env.advance(HOUR);
    ok(env.submit(&t, OTHER_EVIDENCE));

    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Submitted);
    assert_eq!(task.submission_nonce, 2);
    assert_eq!(task.evidence_hash, OTHER_EVIDENCE);
    assert_eq!(task.verified_at, 0);
    assert_eq!(task.review_deadline, 0);
    assert!(!task.has_valid_attestation());

    // The new submission can be attested and then settles normally.
    ok(env.attest(&t));
    assert_eq!(env.task(&t).attested_nonce, 2);
    ok(env.approve(&t));
    assert_eq!(env.balances(&t), paid_to_developer(AMOUNT, FEE));
}

#[test]
fn a_fee_that_floors_to_zero_still_settles_and_leaves_the_treasury_untouched() {
    let mut env = Env::new();
    // 39 * 250 / 10000 = 0.975, which floors to zero.
    let t = env.under_review_task(39);
    ok(env.approve(&t));

    assert_eq!(env.balances(&t), paid_to_developer(39, 0));
    assert_eq!(env.task(&t).state, TaskState::Settled);
    assert!(env.exists(&env.treasury));
    assert!(!env.exists(&t.escrow));
}

#[test]
fn the_smallest_non_zero_fee_is_one_base_unit() {
    let mut env = Env::new();
    let t = env.under_review_task(40);
    ok(env.approve(&t));
    assert_eq!(env.balances(&t), paid_to_developer(40, 1));
}

#[test]
fn zero_fee_settlement_works_on_the_permissionless_paths_too() {
    let mut env = Env::new();
    let t = env.under_review_task(1);
    let review_deadline = env.task(&t).review_deadline;
    env.set_time(review_deadline + 1);
    ok(env.expire_review(&t));
    assert_eq!(env.balances(&t), paid_to_developer(1, 0));

    let t = env.client_disputed_task(39);
    let dispute_deadline = env.task(&t).dispute_deadline;
    env.set_time(dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.balances(&t).developer, 39);
    assert_eq!(env.balances(&t).treasury, 0);
}

#[test]
fn a_stray_deposit_into_escrow_goes_to_the_principal_recipient() {
    let mut env = Env::new();

    // Settlement: the fee stays based on the task amount; the developer gets the rest.
    let t = env.under_review_task(AMOUNT);
    env.create_token_account_at(t.escrow, t.task, AMOUNT + 5);
    ok(env.approve(&t));
    assert_eq!(env.balances(&t).developer, AMOUNT - FEE + 5);
    assert_eq!(env.balances(&t).treasury, FEE);
    assert!(!env.exists(&t.escrow));

    // Refund: the client gets the whole balance.
    let t = env.open_task(AMOUNT);
    env.create_token_account_at(t.escrow, t.task, AMOUNT + 5);
    ok(env.cancel(&t));
    assert_eq!(env.balances(&t).client, AMOUNT + 5);
    assert!(!env.exists(&t.escrow));
}

#[test]
fn treasury_accumulates_fees_across_tasks() {
    let mut env = Env::new();
    for _ in 0..3 {
        let t = env.under_review_task(AMOUNT);
        ok(env.approve(&t));
    }
    assert_eq!(env.token_balance(&env.treasury), 3 * FEE);
}
