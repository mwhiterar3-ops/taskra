//! Double-settlement, deadline-boundary, invalid-transition and mutual-exclusion
//! tests. These back the proof in docs/13-DECISIONS.md §2.6: no sequence of
//! instructions yields two outcomes or two transfers for one task.

mod common;

use common::*;
use taskra::{
    error::TaskraError,
    state::{DisputeResolution, Outcome, TaskState},
};

const AMOUNT: u64 = 100 * USDC;

/// Tries every instruction that could move or redirect funds, at the current
/// time, and asserts each fails without changing any balance or the task.
#[track_caller]
fn assert_every_outcome_instruction_fails(env: &mut Env, t: &TaskCtx) {
    let balances = env.balances(t);
    let state = env.task(t).state;
    let outcome = env.task(t).outcome;

    assert!(env.cancel(t).is_err(), "cancel_task succeeded");
    assert!(env.refund_expired(t).is_err(), "refund_expired succeeded");
    assert!(env.approve(t).is_err(), "approve_task succeeded");
    assert!(env.expire_review(t).is_err(), "expire_review succeeded");
    assert!(
        env.resolve(t, DisputeResolution::PayDeveloper).is_err(),
        "resolve_dispute(PayDeveloper) succeeded"
    );
    assert!(
        env.resolve(t, DisputeResolution::RefundClient).is_err(),
        "resolve_dispute(RefundClient) succeeded"
    );
    assert!(env.expire_dispute(t).is_err(), "expire_dispute succeeded");

    assert_eq!(env.balances(t), balances, "balances changed");
    assert_eq!(env.task(t).state, state, "state changed");
    assert_eq!(env.task(t).outcome, outcome, "outcome changed");
}

/// After a terminal transition nothing at all may succeed, now or at any
/// later time, even if the escrow account is recreated and refilled.
#[track_caller]
fn assert_task_is_final(env: &mut Env, t: &TaskCtx) {
    let balances = env.balances(t);
    let before = env.task(t);
    assert!(matches!(
        before.state,
        TaskState::Settled | TaskState::Refunded | TaskState::Cancelled
    ));

    for delay in [0, 1, WORK_DURATION, 30 * DAY] {
        env.advance(delay);
        assert_every_outcome_instruction_fails(env, t);
        assert!(env.accept(t).is_err(), "accept_task succeeded");
        assert!(env.submit(t, EVIDENCE).is_err(), "submit_work succeeded");
        assert!(env.attest(t).is_err(), "record_attestation succeeded");
        assert!(env.reject(t).is_err(), "reject_task succeeded");
        assert!(
            env.developer_dispute(t).is_err(),
            "open_developer_dispute succeeded"
        );
    }

    // Even with a refilled escrow account at the same address, the terminal
    // state alone blocks every outcome instruction.
    env.create_token_account_at(t.escrow, t.task, t.amount);
    assert!(env.cancel(t).is_err());
    assert!(env.refund_expired(t).is_err());
    assert!(env.approve(t).is_err());
    assert!(env.expire_review(t).is_err());
    assert!(env.resolve(t, DisputeResolution::PayDeveloper).is_err());
    assert!(env.resolve(t, DisputeResolution::RefundClient).is_err());
    assert!(env.expire_dispute(t).is_err());
    assert_eq!(env.token_balance(&t.escrow), t.amount);

    let after = env.task(t);
    assert_eq!(after.state, before.state);
    assert_eq!(after.outcome, before.outcome);
    assert_eq!(after.closed_at, before.closed_at);
    let now = env.balances(t);
    assert_eq!(
        (now.client, now.developer, now.treasury),
        (balances.client, balances.developer, balances.treasury)
    );
}

// --- double settlement: one test per settlement path ----------------------

#[test]
fn no_second_outcome_after_cancel() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    ok(env.cancel(&t));
    assert_eq!(env.task(&t).outcome, Outcome::Cancelled);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_approval_of_an_unattested_submission() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    ok(env.approve(&t));
    assert_eq!(env.task(&t).outcome, Outcome::Approved);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_approval_during_review() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    ok(env.approve(&t));
    assert_eq!(env.task(&t).outcome, Outcome::Approved);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_review_expiry() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    env.set_time(env.task(&t).review_deadline + 1);
    ok(env.expire_review(&t));
    assert_eq!(env.task(&t).outcome, Outcome::ReviewExpired);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_missed_deadline_refund() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    env.set_time(env.task(&t).work_deadline + 1);
    ok(env.refund_expired(&t));
    assert_eq!(env.task(&t).outcome, Outcome::WorkDeadlineMissed);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_never_verified_refund() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).refund_open_at + 1);
    ok(env.refund_expired(&t));
    assert_eq!(env.task(&t).outcome, Outcome::NeverVerified);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_authority_pays_the_developer() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    ok(env.resolve(&t, DisputeResolution::PayDeveloper));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeResolvedForDeveloper);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_authority_refunds_the_client() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    ok(env.resolve(&t, DisputeResolution::RefundClient));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeResolvedForClient);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_dispute_timeout_pays_the_developer() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeExpiredForDeveloper);
    assert_task_is_final(&mut env, &t);
}

#[test]
fn no_second_outcome_after_dispute_timeout_refunds_the_client() {
    let mut env = Env::new();
    let t = env.developer_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeExpiredForClient);
    assert_task_is_final(&mut env, &t);
}

// --- races: two outcome instructions for the same task --------------------

#[test]
fn two_outcome_instructions_in_one_transaction_revert_together() {
    let mut env = Env::new();
    let cranker = env.cranker.insecure_clone();

    // approve + approve
    let t = env.under_review_task(AMOUNT);
    let before = env.balances(&t);
    let pair = [env.approve_ix(&t), env.approve_ix(&t)];
    assert!(env.send(&pair, &[&t.client]).is_err());
    assert_eq!(env.balances(&t), before);
    assert_eq!(env.task(&t).state, TaskState::UnderReview);

    // expire_review + expire_review
    env.set_time(env.task(&t).review_deadline + 1);
    let pair = [env.expire_review_ix(&t), env.expire_review_ix(&t)];
    assert!(env.send(&pair, &[&cranker]).is_err());
    assert_eq!(env.balances(&t), before);
    assert_eq!(env.task(&t).state, TaskState::UnderReview);

    // cancel + cancel, and refund + approve
    let t = env.open_task(AMOUNT);
    let pair = [env.cancel_ix(&t), env.cancel_ix(&t)];
    assert!(env.send(&pair, &[&t.client]).is_err());
    assert_eq!(env.balances(&t).escrow, AMOUNT);

    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).refund_open_at + 1);
    let pair = [env.refund_expired_ix(&t), env.approve_ix(&t)];
    assert!(env.send(&pair, &[&t.client]).is_err());
    let pair = [env.approve_ix(&t), env.refund_expired_ix(&t)];
    assert!(env.send(&pair, &[&t.client]).is_err());
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.task(&t).state, TaskState::Submitted);

    // expire_dispute + expire_dispute
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    let pair = [env.expire_dispute_ix(&t), env.expire_dispute_ix(&t)];
    assert!(env.send(&pair, &[&cranker]).is_err());
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.task(&t).state, TaskState::Disputed);
}

#[test]
fn racing_review_expiry_and_client_approval_pays_exactly_once() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    // Both transactions are built against the same state.
    let approval = env.approve_ix(&t);
    env.set_time(env.task(&t).review_deadline + 1);
    ok(env.expire_review(&t));
    assert!(env.send(&[approval], &[&t.client]).is_err());
    assert_eq!(env.balances(&t).developer, 97_500_000);
    assert_eq!(env.balances(&t).treasury, 2_500_000);
}

#[test]
fn racing_rejection_and_review_expiry_cannot_both_take_effect() {
    let mut env = Env::new();

    // Expiry lands first: the late rejection fails.
    let t = env.under_review_task(AMOUNT);
    let deadline = env.task(&t).review_deadline;
    env.set_time(deadline + 1);
    ok(env.expire_review(&t));
    assert!(env.reject(&t).is_err());
    assert_eq!(env.task(&t).state, TaskState::Settled);

    // Rejection lands first: expiry can no longer pay.
    let t = env.under_review_task(AMOUNT);
    let deadline = env.task(&t).review_deadline;
    env.set_time(deadline);
    ok(env.reject(&t));
    env.set_time(deadline + 1);
    fails_with(env.expire_review(&t), TaskraError::InvalidState);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

#[test]
fn racing_authority_resolution_and_fallback_settle_once() {
    let mut env = Env::new();
    let t = env.client_disputed_task(AMOUNT);
    let deadline = env.task(&t).dispute_deadline;

    // The authority refunds at the last valid second; the fallback (which
    // would have paid the developer) then finds nothing to settle.
    env.set_time(deadline);
    ok(env.resolve(&t, DisputeResolution::RefundClient));
    env.set_time(deadline + 1);
    assert!(env.expire_dispute(&t).is_err());
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);
}

#[test]
fn racing_developer_dispute_and_client_approval_is_safe_either_way() {
    let mut env = Env::new();

    // Approval first: the dispute fails and the developer is paid once.
    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).dispute_open_at + 1);
    ok(env.approve(&t));
    fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
    assert_eq!(env.balances(&t).developer, 97_500_000);

    // Dispute first: the approval fails and escrow stays put.
    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).dispute_open_at + 1);
    let approval = env.approve_ix(&t);
    ok(env.developer_dispute(&t));
    fails_with(
        env.send(&[approval], &[&t.client]),
        TaskraError::InvalidState,
    );
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

// --- deadline boundaries --------------------------------------------------

#[test]
fn work_deadline_boundary() {
    let mut env = Env::new();

    // At the deadline the developer can still submit and the client cannot refund.
    let t = env.accepted_task(AMOUNT);
    let deadline = env.task(&t).work_deadline;
    env.set_time(deadline);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
    ok(env.submit(&t, EVIDENCE));

    // One second later the developer cannot submit and the client can refund.
    let t = env.accepted_task(AMOUNT);
    let deadline = env.task(&t).work_deadline;
    env.set_time(deadline + 1);
    fails_with(env.submit(&t, EVIDENCE), TaskraError::WorkDeadlinePassed);
    ok(env.refund_expired(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);

    // Resubmission is bound by the same deadline, also after an attestation.
    let t = env.under_review_task(AMOUNT);
    let deadline = env.task(&t).work_deadline;
    env.set_time(deadline + 1);
    fails_with(
        env.submit(&t, OTHER_EVIDENCE),
        TaskraError::WorkDeadlinePassed,
    );
    assert_eq!(env.task(&t).state, TaskState::UnderReview);
}

#[test]
fn verification_deadline_boundary() {
    let mut env = Env::new();

    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).verification_deadline);
    ok(env.attest(&t));
    assert_eq!(env.task(&t).state, TaskState::UnderReview);

    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).verification_deadline + 1);
    fails_with(env.attest(&t), TaskraError::VerificationDeadlinePassed);
    assert_eq!(env.task(&t).state, TaskState::Submitted);
}

#[test]
fn review_deadline_boundary() {
    let mut env = Env::new();

    // At the deadline: approve and reject work, expiry does not.
    let t = env.under_review_task(AMOUNT);
    env.set_time(env.task(&t).review_deadline);
    fails_with(env.expire_review(&t), TaskraError::ReviewDeadlineNotPassed);
    ok(env.approve(&t));

    let t = env.under_review_task(AMOUNT);
    env.set_time(env.task(&t).review_deadline);
    ok(env.reject(&t));

    // One second later: approve and reject fail, expiry works.
    let t = env.under_review_task(AMOUNT);
    env.set_time(env.task(&t).review_deadline + 1);
    fails_with(env.approve(&t), TaskraError::ReviewDeadlinePassed);
    fails_with(env.reject(&t), TaskraError::ReviewDeadlinePassed);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    ok(env.expire_review(&t));
    assert_eq!(env.balances(&t).developer, 97_500_000);
}

#[test]
fn developer_dispute_and_client_refund_windows_do_not_overlap() {
    let mut env = Env::new();

    // At dispute_open_at: neither the developer dispute nor the refund is open.
    let t = env.submitted_task(AMOUNT);
    let (open_at, refund_at) = {
        let task = env.task(&t);
        (task.dispute_open_at, task.refund_open_at)
    };
    env.set_time(open_at);
    fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowNotOpen);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);

    // Inside the developer's window the client still cannot refund.
    env.set_time(open_at + 1);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
    env.set_time(refund_at);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
    // The last second of the developer's window still works.
    ok(env.developer_dispute(&t));
    assert_eq!(env.task(&t).state, TaskState::Disputed);

    // One second after the window: the developer is too late, the client refunds.
    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).refund_open_at + 1);
    fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowClosed);
    ok(env.refund_expired(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);
    fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
}

#[test]
fn developer_dispute_window_boundaries_for_a_late_submission() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    let work_deadline = env.task(&t).work_deadline;
    env.set_time(work_deadline);
    ok(env.submit(&t, EVIDENCE));

    // The verification deadline has passed, but a full review window since
    // the submission has not: the developer cannot escalate yet.
    let task = env.task(&t);
    env.set_time(task.verification_deadline + 1);
    fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowNotOpen);
    env.set_time(work_deadline + REVIEW_WINDOW);
    fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowNotOpen);
    env.set_time(work_deadline + REVIEW_WINDOW + 1);
    ok(env.developer_dispute(&t));
}

#[test]
fn attester_window_and_developer_dispute_window_do_not_overlap() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let task = env.task(&t);
    assert!(task.dispute_open_at >= task.verification_deadline);

    // While the attester may still act, the developer cannot escalate.
    env.set_time(task.verification_deadline);
    fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowNotOpen);

    // Once the developer may escalate, the attester can no longer act.
    env.set_time(task.dispute_open_at + 1);
    fails_with(env.attest(&t), TaskraError::VerificationDeadlinePassed);
    ok(env.developer_dispute(&t));
    fails_with(env.attest(&t), TaskraError::InvalidState);
}

#[test]
fn dispute_deadline_boundary() {
    let mut env = Env::new();

    // At the deadline the authority can resolve and the fallback cannot run.
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline);
    fails_with(
        env.expire_dispute(&t),
        TaskraError::DisputeDeadlineNotPassed,
    );
    ok(env.resolve(&t, DisputeResolution::PayDeveloper));

    // One second later the authority is too late and the fallback runs.
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    for resolution in [
        DisputeResolution::PayDeveloper,
        DisputeResolution::RefundClient,
    ] {
        fails_with(
            env.resolve(&t, resolution),
            TaskraError::DisputeDeadlinePassed,
        );
    }
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    ok(env.expire_dispute(&t));
}

// --- mutual exclusion per state (decision 7) ------------------------------

#[test]
fn open_task_allows_only_cancel_or_accept() {
    let mut env = Env::new();
    let t = env.open_task(AMOUNT);
    for delay in [0, WORK_DURATION, 30 * DAY] {
        env.advance(delay);
        fails_with(env.refund_expired(&t), TaskraError::InvalidState);
        assert!(env.approve(&t).is_err());
        assert!(env.expire_review(&t).is_err());
        assert!(env.resolve(&t, DisputeResolution::RefundClient).is_err());
        assert!(env.expire_dispute(&t).is_err());
        fails_with(env.attest(&t), TaskraError::InvalidState);
        fails_with(env.reject(&t), TaskraError::InvalidState);
    }
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    assert_eq!(env.task(&t).state, TaskState::Open);
}

#[test]
fn accepted_task_has_exactly_one_exit_at_any_time() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);

    // Before the work deadline nothing can move funds.
    assert_every_outcome_instruction_fails(&mut env, &t);
    fails_with(env.cancel(&t), TaskraError::InvalidState);
    fails_with(env.attest(&t), TaskraError::InvalidState);
    fails_with(env.reject(&t), TaskraError::InvalidState);
    fails_with(env.developer_dispute(&t), TaskraError::InvalidState);

    // After it, only the client's refund is available.
    env.set_time(env.task(&t).work_deadline + 1);
    fails_with(env.cancel(&t), TaskraError::InvalidState);
    assert!(env.approve(&t).is_err());
    assert!(env.expire_review(&t).is_err());
    assert!(env.resolve(&t, DisputeResolution::PayDeveloper).is_err());
    assert!(env.expire_dispute(&t).is_err());
    fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
    ok(env.refund_expired(&t));
}

#[test]
fn submitted_task_outcomes_are_client_signed_only() {
    let mut env = Env::new();
    let t = env.submitted_task(AMOUNT);
    let task = env.task(&t);

    // At every point of the SUBMITTED timeline, the permissionless and
    // authority paths are closed; only the client can produce an outcome.
    for time in [
        env.now(),
        task.work_deadline + 1,
        task.verification_deadline + 1,
        task.dispute_open_at + 1,
        task.refund_open_at + 1,
        task.refund_open_at + 30 * DAY,
    ] {
        env.set_time(time);
        fails_with(env.cancel(&t), TaskraError::InvalidState);
        fails_with(env.expire_review(&t), TaskraError::InvalidState);
        fails_with(env.reject(&t), TaskraError::InvalidState);
        fails_with(
            env.resolve(&t, DisputeResolution::PayDeveloper),
            TaskraError::InvalidState,
        );
        fails_with(
            env.resolve(&t, DisputeResolution::RefundClient),
            TaskraError::InvalidState,
        );
        fails_with(env.expire_dispute(&t), TaskraError::InvalidState);
        assert_eq!(env.balances(&t).escrow, AMOUNT);
        assert_eq!(env.task(&t).state, TaskState::Submitted);
    }
}

#[test]
fn under_review_task_never_allows_refund_or_developer_dispute() {
    let mut env = Env::new();
    let t = env.under_review_task(AMOUNT);
    let task = env.task(&t);

    for time in [
        env.now(),
        task.review_deadline,
        task.review_deadline + 1,
        task.refund_open_at + 1,
        task.refund_open_at + 30 * DAY,
    ] {
        env.set_time(time);
        fails_with(env.refund_expired(&t), TaskraError::InvalidState);
        fails_with(env.cancel(&t), TaskraError::InvalidState);
        fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
        fails_with(env.attest(&t), TaskraError::InvalidState);
        fails_with(
            env.resolve(&t, DisputeResolution::RefundClient),
            TaskraError::InvalidState,
        );
        fails_with(env.expire_dispute(&t), TaskraError::InvalidState);
        assert_eq!(env.balances(&t).escrow, AMOUNT);
    }
    // After all of that the developer is still paid in full by expiry.
    ok(env.expire_review(&t));
    assert_eq!(env.balances(&t).developer, 97_500_000);
}

#[test]
fn disputed_task_can_only_be_ended_by_the_authority_or_the_fallback() {
    for by_developer in [false, true] {
        let mut env = Env::new();
        let t = if by_developer {
            env.developer_disputed_task(AMOUNT)
        } else {
            env.client_disputed_task(AMOUNT)
        };
        let task = env.task(&t);

        for time in [
            env.now(),
            task.dispute_deadline,
            task.dispute_deadline + 1,
            task.dispute_deadline + 30 * DAY,
        ] {
            env.set_time(time);
            fails_with(env.cancel(&t), TaskraError::InvalidState);
            fails_with(env.refund_expired(&t), TaskraError::InvalidState);
            fails_with(env.approve(&t), TaskraError::InvalidState);
            fails_with(env.expire_review(&t), TaskraError::InvalidState);
            fails_with(env.reject(&t), TaskraError::InvalidState);
            fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
            fails_with(env.submit(&t, OTHER_EVIDENCE), TaskraError::InvalidState);
            fails_with(env.attest(&t), TaskraError::InvalidState);
            assert_eq!(env.balances(&t).escrow, AMOUNT);
            assert_eq!(env.task(&t).state, TaskState::Disputed);
        }
    }
}

#[test]
fn dispute_fallback_branch_depends_only_on_the_attestation() {
    let mut env = Env::new();

    // No attestation can be added once a task is disputed, so a developer
    // dispute can never be turned into a paying fallback by the attester.
    let t = env.developer_disputed_task(AMOUNT);
    fails_with(env.attest(&t), TaskraError::InvalidState);
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);

    // Nor can a verified dispute lose its attestation: resubmission is blocked.
    let t = env.client_disputed_task(AMOUNT);
    fails_with(env.submit(&t, OTHER_EVIDENCE), TaskraError::InvalidState);
    assert!(env.task(&t).has_valid_attestation());
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.balances(&t).developer, 97_500_000);
    assert_eq!(env.balances(&t).client, 0);
}

#[test]
fn every_non_terminal_state_reaches_a_terminal_state_without_the_other_party() {
    let mut env = Env::new();

    // OPEN: the client cancels.
    let t = env.open_task(AMOUNT);
    ok(env.cancel(&t));

    // ACCEPTED, developer vanished: the client refunds after the deadline.
    let t = env.accepted_task(AMOUNT);
    env.set_time(env.task(&t).work_deadline + 1);
    ok(env.refund_expired(&t));

    // SUBMITTED, client and attester vanished: the developer escalates, and
    // with the authority also absent the fallback ends it.
    let t = env.developer_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).state, TaskState::Refunded);

    // SUBMITTED, developer vanished too: the client refunds.
    let t = env.submitted_task(AMOUNT);
    env.set_time(env.task(&t).refund_open_at + 1);
    ok(env.refund_expired(&t));

    // UNDER_REVIEW, client vanished: anyone expires the review.
    let t = env.under_review_task(AMOUNT);
    env.set_time(env.task(&t).review_deadline + 1);
    ok(env.expire_review(&t));

    // DISPUTED, authority vanished: anyone runs the fallback.
    let t = env.client_disputed_task(AMOUNT);
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).state, TaskState::Settled);
}
