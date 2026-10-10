//! Bounds on `work_duration` and the platform windows, and proof by execution
//! that a task created at those bounds can still reach a terminal state on
//! every path.
//!
//! Before the bounds existed, a task created with a work duration close to
//! `i64::MAX` could be accepted and then never submitted (the submission
//! deadlines overflowed), cancelled (not `OPEN`) or refunded (the work deadline
//! never arrives): its escrow was locked for good.

mod common;

use common::*;
use solana_signer::Signer;
use taskra::{
    constants::{MAX_WINDOW, MAX_WORK_DURATION},
    error::TaskraError,
    state::{Outcome, TaskState},
};

const AMOUNT: u64 = 100 * USDC;

/// A funded, `OPEN` task with the given work duration.
fn open_task_with(env: &mut Env, work_duration: i64) -> TaskCtx {
    let client = env.wallet(AMOUNT);
    let developer = env.wallet(0);
    let task_id = env.next_task_id();
    let create = env.create_ix(&client.pubkey(), task_id, AMOUNT, work_duration, TERMS_HASH);
    ok(env.send(&[create], &[&client]));
    let task = task_address(&client.pubkey(), &task_id);
    TaskCtx {
        client,
        developer,
        task_id,
        task,
        escrow: escrow_address(&task),
        amount: AMOUNT,
    }
}

#[test]
fn create_rejects_a_work_duration_above_the_maximum() {
    let mut env = Env::new();
    let client = env.wallet(AMOUNT);
    // The last value is the one that locked escrow before the bound existed:
    // acceptance fits in an i64, the submission deadlines do not.
    let trap = i64::MAX - START_TIME - 12;
    for duration in [
        MAX_WORK_DURATION + 1,
        10 * MAX_WORK_DURATION,
        trap,
        i64::MAX,
    ] {
        let task_id = env.next_task_id();
        let create = env.create_ix(&client.pubkey(), task_id, AMOUNT, duration, TERMS_HASH);
        fails_with(
            env.send(&[create], &[&client]),
            TaskraError::InvalidWorkDuration,
        );
        let task = task_address(&client.pubkey(), &task_id);
        assert!(!env.exists(&task));
        assert!(!env.exists(&escrow_address(&task)));
    }
    assert_eq!(env.token_balance(&env.ata(&client.pubkey())), AMOUNT);
}

#[test]
fn create_accepts_the_boundary_durations() {
    let mut env = Env::new();
    for duration in [1, MAX_WORK_DURATION - 1, MAX_WORK_DURATION] {
        let t = open_task_with(&mut env, duration);
        assert_eq!(env.task(&t).work_duration, duration);
        assert_eq!(env.task(&t).state, TaskState::Open);
    }
}

#[test]
fn initialization_rejects_windows_above_the_maximum() {
    let mut env = Env::uninitialized();
    for field in 0..3 {
        for bad in [MAX_WINDOW + 1, i64::MAX] {
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

    let mut args = env.default_init_args();
    args.review_window = MAX_WINDOW;
    args.verification_grace = MAX_WINDOW;
    args.dispute_timeout = MAX_WINDOW;
    let accounts = env.initialize_accounts();
    ok(env.initialize(accounts, args));
}

/// Every deadline the program can compute, at the largest values it accepts.
fn largest_env() -> Env {
    Env::with_windows(MAX_WINDOW, MAX_WINDOW, MAX_WINDOW)
}

#[test]
fn at_the_bounds_an_abandoned_accepted_task_is_refundable() {
    let mut env = largest_env();
    let t = open_task_with(&mut env, MAX_WORK_DURATION);
    ok(env.accept(&t));
    let work_deadline = env.task(&t).work_deadline;
    assert_eq!(work_deadline, env.now() + MAX_WORK_DURATION);

    env.set_time(work_deadline);
    fails_with(env.refund_expired(&t), TaskraError::RefundNotOpen);
    env.set_time(work_deadline + 1);
    ok(env.refund_expired(&t));
    assert_eq!(env.task(&t).state, TaskState::Refunded);
    assert_eq!(env.token_balance(&env.ata(&t.client.pubkey())), AMOUNT);
    assert!(!env.exists(&t.escrow));
}

#[test]
fn at_the_bounds_a_last_second_unverified_submission_is_refundable() {
    let mut env = largest_env();
    let t = open_task_with(&mut env, MAX_WORK_DURATION);
    ok(env.accept(&t));
    // Submitting at the work deadline produces the latest possible windows.
    env.set_time(env.task(&t).work_deadline);
    ok(env.submit(&t, EVIDENCE));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Submitted);
    assert!(task.dispute_open_at > task.work_deadline);
    assert_eq!(task.refund_open_at, task.dispute_open_at + MAX_WINDOW);

    env.set_time(task.refund_open_at + 1);
    ok(env.refund_expired(&t));
    assert_eq!(env.task(&t).outcome, Outcome::NeverVerified);
    assert_eq!(env.token_balance(&env.ata(&t.client.pubkey())), AMOUNT);
}

#[test]
fn at_the_bounds_a_developer_dispute_ends_by_the_fallback() {
    let mut env = largest_env();
    let t = open_task_with(&mut env, MAX_WORK_DURATION);
    ok(env.accept(&t));
    env.set_time(env.task(&t).work_deadline);
    ok(env.submit(&t, EVIDENCE));
    // The last second of the developer's window.
    env.set_time(env.task(&t).refund_open_at);
    ok(env.developer_dispute(&t));
    let dispute_deadline = env.task(&t).dispute_deadline;
    assert_eq!(dispute_deadline, env.now() + MAX_WINDOW);

    env.set_time(dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).state, TaskState::Refunded);
    assert_eq!(env.token_balance(&env.ata(&t.client.pubkey())), AMOUNT);
}

#[test]
fn at_the_bounds_verified_work_settles_by_review_expiry_or_dispute_fallback() {
    for reject in [false, true] {
        let mut env = largest_env();
        let t = open_task_with(&mut env, MAX_WORK_DURATION);
        ok(env.accept(&t));
        env.set_time(env.task(&t).work_deadline);
        ok(env.submit(&t, EVIDENCE));
        // The last second the attester may act.
        env.set_time(env.task(&t).verification_deadline);
        ok(env.attest(&t));
        let review_deadline = env.task(&t).review_deadline;
        assert_eq!(review_deadline, env.now() + MAX_WINDOW);

        if reject {
            env.set_time(review_deadline);
            ok(env.reject(&t));
            env.set_time(env.task(&t).dispute_deadline + 1);
            ok(env.expire_dispute(&t));
        } else {
            env.set_time(review_deadline + 1);
            ok(env.expire_review(&t));
        }
        assert_eq!(env.task(&t).state, TaskState::Settled);
        assert!(!env.exists(&t.escrow));
    }
}

#[test]
fn the_longest_possible_lock_is_five_maximum_periods_after_acceptance() {
    // work_duration + max(review, grace) + review + dispute_timeout, all at
    // their maximum, plus the second after it: the latest any escrow can be held.
    let mut env = largest_env();
    let t = open_task_with(&mut env, MAX_WORK_DURATION);
    ok(env.accept(&t));
    let accepted_at = env.now();
    env.set_time(env.task(&t).work_deadline);
    ok(env.submit(&t, EVIDENCE));
    env.set_time(env.task(&t).refund_open_at);
    ok(env.developer_dispute(&t));
    let latest = env.task(&t).dispute_deadline;
    assert_eq!(latest, accepted_at + MAX_WORK_DURATION + 3 * MAX_WINDOW);
    assert!(latest < START_TIME + 5 * MAX_WINDOW);
    env.set_time(latest + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.task(&t).state, TaskState::Refunded);
}
