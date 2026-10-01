//! How long a client's funds can be held by a developer who submits junk and
//! then stalls. The formula and timeline are documented in
//! docs/13-DECISIONS.md §2.7; these tests derive the same numbers from the
//! program and fail if the two ever diverge.

mod common;

use common::*;
use taskra::{
    error::TaskraError,
    state::{Outcome, TaskState},
};

const AMOUNT: u64 = 100 * USDC;
const JUNK: [u8; 32] = [0xAB; 32];

/// (name, review_window, verification_grace, dispute_timeout)
const PROFILES: [(&str, i64, i64, i64); 3] = [
    ("production", 48 * HOUR, 24 * HOUR, 7 * DAY),
    ("devnet-demo", 600, 300, 900),
    // Not a deploy profile: exercises the branch where the grace period,
    // not the review window, decides when the developer may escalate.
    ("grace-dominant", HOUR, 5 * HOUR, 2 * HOUR),
];

/// docs/13-DECISIONS.md §2.7: the longest time after acceptance during which
/// the client cannot recover escrow, when the developer never earns payment.
fn max_client_lock(work_duration: i64, review: i64, grace: i64, dispute_timeout: i64) -> i64 {
    work_duration + review.max(grace) + review + dispute_timeout
}

/// While the task is `SUBMITTED`, no permissionless instruction pays anyone.
#[track_caller]
fn assert_developer_cannot_be_paid(env: &mut Env, t: &TaskCtx) {
    assert_eq!(env.task(t).state, TaskState::Submitted);
    assert!(env.expire_review(t).is_err());
    assert!(env.expire_dispute(t).is_err());
    assert_eq!(env.balances(t).developer, 0);
    assert_eq!(env.balances(t).treasury, 0);
}

#[test]
fn worst_case_client_lock_equals_the_documented_formula() {
    for (name, review, grace, dispute_timeout) in PROFILES {
        let mut env = Env::with_windows(review, grace, dispute_timeout);
        let t = env.accepted_task(AMOUNT);
        let accepted_at = env.task(&t).accepted_at;
        let lock = max_client_lock(WORK_DURATION, review, grace, dispute_timeout);
        let work_deadline = accepted_at + WORK_DURATION;

        // The developer submits junk at the last valid second...
        env.set_time(work_deadline);
        ok(env.submit(&t, JUNK));
        let task = env.task(&t);
        assert_eq!(
            task.dispute_open_at,
            work_deadline + review.max(grace),
            "{name}"
        );
        assert_eq!(
            task.refund_open_at,
            work_deadline + review.max(grace) + review,
            "{name}"
        );

        // ...the client cannot refund while the developer may still escalate...
        for time in [
            work_deadline + 1,
            task.verification_deadline + 1,
            task.dispute_open_at,
            task.dispute_open_at + 1,
            task.refund_open_at,
        ] {
            env.set_time(time);
            fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
            assert_developer_cannot_be_paid(&mut env, &t);
        }

        // ...and the developer escalates at the last valid second.
        ok(env.developer_dispute(&t));
        let task = env.task(&t);
        assert_eq!(task.dispute_deadline, accepted_at + lock, "{name}");

        // The dispute cannot be extended or reopened by the developer.
        fails_with(env.developer_dispute(&t), TaskraError::InvalidState);
        fails_with(env.submit(&t, EVIDENCE), TaskraError::InvalidState);

        // Up to and including the dispute deadline the client cannot recover funds
        // without the authority.
        env.set_time(accepted_at + lock);
        fails_with(env.refund_expired(&t), TaskraError::InvalidState);
        fails_with(
            env.expire_dispute(&t),
            TaskraError::DisputeDeadlineNotPassed,
        );
        assert_eq!(env.balances(&t).escrow, AMOUNT);
        assert_eq!(env.balances(&t).client, 0);

        // One second later anyone returns the funds to the client.
        env.set_time(accepted_at + lock + 1);
        ok(env.expire_dispute(&t));
        assert_eq!(env.balances(&t).client, AMOUNT, "{name}");
        assert_eq!(env.balances(&t).developer, 0, "{name}");
        assert_eq!(env.balances(&t).treasury, 0, "{name}");
        assert_eq!(env.task(&t).outcome, Outcome::DisputeExpiredForClient);
        assert_eq!(env.now() - accepted_at, lock + 1, "{name}");
    }
}

#[test]
fn production_worst_case_is_work_duration_plus_eleven_days() {
    assert_eq!(
        max_client_lock(WORK_DURATION, 48 * HOUR, 24 * HOUR, 7 * DAY),
        WORK_DURATION + 11 * DAY
    );
    assert_eq!(
        max_client_lock(WORK_DURATION, 600, 300, 900),
        WORK_DURATION + 35 * 60
    );
}

#[test]
fn junk_at_the_deadline_without_escalation_is_refundable_after_two_windows() {
    for (name, review, grace, dispute_timeout) in PROFILES {
        let mut env = Env::with_windows(review, grace, dispute_timeout);
        let t = env.accepted_task(AMOUNT);
        let work_deadline = env.task(&t).work_deadline;
        env.set_time(work_deadline);
        ok(env.submit(&t, JUNK));

        let refundable_after = work_deadline + review.max(grace) + review;
        env.set_time(refundable_after);
        fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
        env.set_time(refundable_after + 1);
        ok(env.refund_expired(&t));
        assert_eq!(env.balances(&t).client, AMOUNT, "{name}");
        assert_eq!(env.balances(&t).developer, 0, "{name}");
    }
}

#[test]
fn junk_submitted_early_without_escalation_is_refundable_after_grace_plus_review() {
    // Production windows: submitted one hour after acceptance, so the
    // verification deadline (not the submission time) bounds the escalation.
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    let work_deadline = env.task(&t).work_deadline;
    env.advance(HOUR);
    ok(env.submit(&t, JUNK));

    let refundable_after = work_deadline + VERIFICATION_GRACE + REVIEW_WINDOW;
    assert_eq!(env.task(&t).refund_open_at, refundable_after);
    env.set_time(refundable_after);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
    assert_developer_cannot_be_paid(&mut env, &t);
    env.set_time(refundable_after + 1);
    ok(env.refund_expired(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);
}

#[test]
fn resubmitting_cannot_push_the_refund_past_the_documented_bound() {
    for (name, review, grace, dispute_timeout) in PROFILES {
        let mut env = Env::with_windows(review, grace, dispute_timeout);
        let t = env.accepted_task(AMOUNT);
        let work_deadline = env.task(&t).work_deadline;
        let bound = work_deadline + review.max(grace) + review;

        // Resubmit repeatedly, right up to the deadline.
        let mut time = env.now();
        while time <= work_deadline {
            env.set_time(time);
            ok(env.submit(&t, JUNK));
            assert!(env.task(&t).refund_open_at <= bound, "{name}");
            time += WORK_DURATION / 7;
        }
        env.set_time(work_deadline);
        ok(env.submit(&t, JUNK));
        assert_eq!(env.task(&t).refund_open_at, bound, "{name}");

        // After the deadline no further resubmission can move it.
        env.set_time(work_deadline + 1);
        fails_with(env.submit(&t, JUNK), TaskraError::WorkDeadlinePassed);
        assert_eq!(env.task(&t).refund_open_at, bound, "{name}");
    }
}

#[test]
fn developer_dispute_window_boundaries_hold_for_every_profile() {
    for (name, review, grace, dispute_timeout) in PROFILES {
        let mut env = Env::with_windows(review, grace, dispute_timeout);
        let t = env.accepted_task(AMOUNT);
        env.set_time(env.task(&t).work_deadline);
        ok(env.submit(&t, JUNK));
        let (open_at, refund_at) = {
            let task = env.task(&t);
            (task.dispute_open_at, task.refund_open_at)
        };

        env.set_time(open_at);
        fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowNotOpen);
        env.set_time(refund_at + 1);
        fails_with(env.developer_dispute(&t), TaskraError::DisputeWindowClosed);
        env.set_time(open_at + 1);
        ok(env.developer_dispute(&t));
        assert_eq!(
            env.task(&t).dispute_deadline,
            open_at + 1 + dispute_timeout,
            "{name}"
        );
    }
}

#[test]
fn the_authority_can_end_a_stalling_dispute_at_any_time_before_the_fallback() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    env.set_time(env.task(&t).work_deadline);
    ok(env.submit(&t, JUNK));
    env.set_time(env.task(&t).refund_open_at);
    ok(env.developer_dispute(&t));

    // The seven-day wait applies only when the authority is absent.
    ok(env.resolve(&t, taskra::state::DisputeResolution::RefundClient));
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);
}
