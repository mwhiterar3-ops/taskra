//! Randomized sequences: random instructions, random signers and random clock
//! advances against one task, with the safety invariants checked after every
//! step.
//!
//! Each step is either *guided* (an instruction that fits the task's current
//! state, so sequences reach attestation, review, dispute and expiry) or
//! *unguided* (any instruction, any signer, any arguments, any time jump).
//!
//! Sequences are deterministic per seed. `FIXED_SEED` always runs; the range
//! `0..TASKRA_FUZZ_SEEDS` (default 48) runs alongside it, each for
//! `TASKRA_FUZZ_STEPS` steps (default 60). Raise both in CI for a longer run.
//! A failing run prints its seed and the full step trace.

mod common;

use anchor_lang::solana_program::instruction::Instruction;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::collections::BTreeMap;
use taskra::{
    fees::compute_fee,
    instruction,
    state::{DisputeResolution, Outcome, Task, TaskState},
};

const FIXED_SEED: u64 = 0x7A5C_2026;
const DEFAULT_SEEDS: u64 = 48;
const DEFAULT_STEPS: u64 = 60;

const CLIENT: usize = 0;
const ATTESTER: usize = 2;
const AUTHORITY: usize = 3;
const STRANGER: usize = 4;
const ACTOR_NAMES: [&str; 5] = ["client", "developer", "attester", "authority", "stranger"];

const AMOUNTS: [u64; 5] = [1, 39, 40, 100 * USDC, 12_345_677];
const HASHES: [[u8; 32]; 3] = [EVIDENCE, OTHER_EVIDENCE, [0; 32]];
const ADVANCES: [i64; 8] = [1, 60, HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 8 * DAY];

/// SplitMix64: small, deterministic, and good enough to drive a test.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

#[derive(Debug, Clone, Copy)]
enum Action {
    Accept,
    Submit([u8; 32]),
    Attest([u8; 32], u64),
    Approve([u8; 32]),
    Reject,
    DeveloperDispute,
    ExpireReview,
    Cancel,
    RefundExpired,
    Resolve(DisputeResolution),
    ExpireDispute,
    /// Move the clock forward by this many seconds.
    Advance(i64),
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn is_terminal(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Settled | TaskState::Refunded | TaskState::Cancelled
    )
}

/// Seconds from `now` to one second past `deadline` (at least one second).
fn until_after(now: i64, deadline: i64) -> Action {
    Action::Advance((deadline + 1 - now).max(1))
}

/// Any instruction, any signer, any arguments.
fn unguided(rng: &mut Rng, task: &Task) -> (Action, usize) {
    let hash = rng.pick(&[task.evidence_hash, EVIDENCE, OTHER_EVIDENCE, [0; 32]]);
    let nonce = rng.pick(&[
        task.submission_nonce,
        task.submission_nonce.wrapping_sub(1),
        task.submission_nonce + 1,
    ]);
    let resolution = rng.pick(&[
        DisputeResolution::PayDeveloper,
        DisputeResolution::RefundClient,
    ]);
    let action = match rng.below(12) {
        0 => Action::Accept,
        1 => Action::Submit(rng.pick(&HASHES)),
        2 => Action::Attest(hash, nonce),
        3 => Action::Approve(hash),
        4 => Action::Reject,
        5 => Action::DeveloperDispute,
        6 => Action::ExpireReview,
        7 => Action::Cancel,
        8 => Action::RefundExpired,
        9 => Action::Resolve(resolution),
        10 => Action::ExpireDispute,
        _ => Action::Advance(rng.pick(&ADVANCES)),
    };
    (action, rng.below(5) as usize)
}

/// An instruction that fits the current state, signed by the right role.
fn guided(rng: &mut Rng, task: &Task, developer: usize, now: i64) -> (Action, usize) {
    let roll = rng.below(100);
    match task.state {
        TaskState::Open => {
            if roll < 80 {
                (Action::Accept, 1 + rng.below(4) as usize)
            } else {
                (Action::Cancel, CLIENT)
            }
        }
        TaskState::Accepted => match roll {
            0..=69 => (
                Action::Submit(rng.pick(&[EVIDENCE, OTHER_EVIDENCE])),
                developer,
            ),
            70..=84 => (until_after(now, task.work_deadline), STRANGER),
            _ => (Action::RefundExpired, CLIENT),
        },
        TaskState::Submitted => match roll {
            0..=34 => (
                Action::Attest(task.evidence_hash, task.submission_nonce),
                ATTESTER,
            ),
            35..=44 => (Action::Approve(task.evidence_hash), CLIENT),
            45..=54 => (
                Action::Submit(rng.pick(&[EVIDENCE, OTHER_EVIDENCE])),
                developer,
            ),
            55..=69 => (until_after(now, task.dispute_open_at), STRANGER),
            70..=79 => (Action::DeveloperDispute, developer),
            80..=89 => (until_after(now, task.refund_open_at), STRANGER),
            _ => (Action::RefundExpired, CLIENT),
        },
        TaskState::UnderReview => match roll {
            0..=19 => (Action::Approve(task.evidence_hash), CLIENT),
            20..=44 => (Action::Reject, CLIENT),
            45..=64 => (until_after(now, task.review_deadline), STRANGER),
            65..=89 => (Action::ExpireReview, STRANGER),
            _ => (
                Action::Submit(rng.pick(&[EVIDENCE, OTHER_EVIDENCE])),
                developer,
            ),
        },
        TaskState::Disputed => match roll {
            0..=29 => (
                Action::Resolve(rng.pick(&[
                    DisputeResolution::PayDeveloper,
                    DisputeResolution::RefundClient,
                ])),
                AUTHORITY,
            ),
            30..=64 => (until_after(now, task.dispute_deadline), STRANGER),
            _ => (Action::ExpireDispute, STRANGER),
        },
        // Nothing fits a terminal task: keep attacking it at random.
        TaskState::Settled | TaskState::Refunded | TaskState::Cancelled => unguided(rng, task),
    }
}

fn build(env: &Env, t: &TaskCtx, action: Action, signer: &Keypair) -> Option<Instruction> {
    let key = signer.pubkey();
    Some(match action {
        Action::Accept => env.accept_ix(t, &key),
        Action::Submit(hash) => env.submit_ix(t, &key, hash),
        Action::Attest(hash, nonce) => env.attest_ix(t, &key, hash, nonce),
        Action::Approve(evidence_hash) => {
            let mut accounts = env.approve_accounts(t);
            accounts.client = key;
            ix(accounts, instruction::ApproveTask { evidence_hash })
        }
        Action::Reject => env.reject_ix(t, &key, REASON),
        Action::DeveloperDispute => env.developer_dispute_ix(t, &key),
        Action::ExpireReview => env.expire_review_ix(t),
        Action::Cancel | Action::RefundExpired => {
            let mut accounts = env.client_refund_accounts(t);
            accounts.client = key;
            accounts.client_token = env.ata(&key);
            if matches!(action, Action::Cancel) {
                ix(accounts, instruction::CancelTask {})
            } else {
                ix(accounts, instruction::RefundExpired {})
            }
        }
        Action::Resolve(resolution) => {
            let mut accounts = env.resolve_accounts(t);
            accounts.authority = key;
            ix(accounts, instruction::ResolveDispute { resolution })
        }
        Action::ExpireDispute => env.expire_dispute_ix(t),
        Action::Advance(_) => return None,
    })
}

/// Runs one random sequence and returns the task's final (state, outcome).
fn run_sequence(seed: u64, steps: u64) -> (TaskState, Outcome) {
    println!("=== seed {seed:#x} ({seed}), {steps} steps");
    let mut rng = Rng(seed);
    let mut env = Env::new();
    let amount = rng.pick(&AMOUNTS);
    let mut t = env.open_task(amount);
    let fee = compute_fee(amount, FEE_BPS).unwrap();

    // Every actor can sign and has a USDC account, so any of them can try any role.
    let actors: [Keypair; 5] = [
        t.client.insecure_clone(),
        t.developer.insecure_clone(),
        env.attester.insecure_clone(),
        env.authority.insecure_clone(),
        env.wallet(0),
    ];
    for index in [ATTESTER, AUTHORITY] {
        env.create_ata(env.mint, actors[index].pubkey(), 0);
    }
    let mut developer = 1;
    let mut terminal: Option<(TaskState, Outcome, i64)> = None;

    for step in 0..steps {
        let task = env.task(&t);
        let (action, who) = if rng.below(100) < 65 {
            guided(&mut rng, &task, developer, env.now())
        } else {
            unguided(&mut rng, &task)
        };
        let actor = &actors[who];

        match build(&env, &t, action, actor) {
            None => {
                if let Action::Advance(seconds) = action {
                    env.advance(seconds);
                    println!("step {step}: advance clock {seconds}s");
                }
            }
            Some(instruction) => {
                // Sometimes the same instruction twice in one transaction.
                let doubled = rng.below(8) == 0;
                let instructions = if doubled {
                    vec![instruction.clone(), instruction]
                } else {
                    vec![instruction]
                };
                let succeeded = env.send(&instructions, &[actor]).is_ok();
                println!(
                    "step {step}: {action:?}{} by {} -> {}",
                    if doubled { " x2" } else { "" },
                    ACTOR_NAMES[who],
                    if succeeded { "ok" } else { "rejected" }
                );
                if succeeded && matches!(action, Action::Accept) {
                    developer = who;
                    t.developer = actor.insecure_clone();
                }
            }
        }

        // ---- invariants, checked after every step ----
        let task = env.task(&t);
        let escrow = env.token_balance(&t.escrow);
        let treasury = env.token_balance(&env.treasury);
        let wallets: Vec<u64> = actors
            .iter()
            .map(|actor| env.token_balance(&env.ata(&actor.pubkey())))
            .collect();
        let paid_out: u64 = wallets.iter().sum::<u64>() + treasury;

        // Tokens are conserved and never created: payouts never exceed the amount.
        assert!(
            paid_out <= amount,
            "seed {seed}: paid out more than the amount"
        );
        assert_eq!(
            escrow + paid_out,
            amount,
            "seed {seed}: tokens not conserved"
        );

        if is_terminal(task.state) {
            // (a) a terminal task has a closed, empty escrow...
            assert_eq!(escrow, 0, "seed {seed}");
            assert!(!env.exists(&t.escrow), "seed {seed}: escrow left open");
            // ...and the whole amount went exactly where its outcome says.
            let mut expected = vec![0; actors.len()];
            let expected_treasury = if task.state == TaskState::Settled {
                expected[developer] = amount - fee;
                fee
            } else {
                expected[CLIENT] = amount;
                0
            };
            assert_eq!(wallets, expected, "seed {seed}: wrong recipients");
            assert_eq!(treasury, expected_treasury, "seed {seed}: wrong fee");
            assert_ne!(task.outcome, Outcome::None, "seed {seed}");
            // (b) at most one terminal outcome, and it never changes afterwards.
            let reached = (task.state, task.outcome, task.closed_at);
            match terminal {
                None => terminal = Some(reached),
                Some(first) => assert_eq!(first, reached, "seed {seed}: outcome changed"),
            }
        } else {
            // (a) a live task holds exactly its amount in escrow; nothing was paid.
            assert!(terminal.is_none(), "seed {seed}: left a terminal state");
            assert_eq!(escrow, amount, "seed {seed}: live escrow != amount");
            assert_eq!(paid_out, 0, "seed {seed}: paid before a terminal state");
            assert_eq!(task.outcome, Outcome::None, "seed {seed}");
        }
        // Once accepted, the recorded developer never changes.
        if task.accepted_at != 0 {
            assert_eq!(task.developer, actors[developer].pubkey(), "seed {seed}");
        }
        // A developer payment without an attestation needs the client or the authority.
        if matches!(
            task.outcome,
            Outcome::ReviewExpired | Outcome::DisputeExpiredForDeveloper
        ) {
            assert!(
                task.has_valid_attestation(),
                "seed {seed}: paid without attestation"
            );
        }
    }

    let task = env.task(&t);
    println!(
        "=== seed {seed}: ended {:?} / {:?}",
        task.state, task.outcome
    );
    (task.state, task.outcome)
}

#[test]
fn fixed_seed_sequence_preserves_the_invariants() {
    let steps = env_u64("TASKRA_FUZZ_STEPS", DEFAULT_STEPS);
    run_sequence(FIXED_SEED, steps);
}

#[test]
fn seed_range_sequences_preserve_the_invariants() {
    let seeds = env_u64("TASKRA_FUZZ_SEEDS", DEFAULT_SEEDS);
    let steps = env_u64("TASKRA_FUZZ_STEPS", DEFAULT_STEPS);

    let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
    for seed in 0..seeds {
        let (_, outcome) = run_sequence(seed, steps);
        *outcomes.entry(format!("{outcome:?}")).or_default() += 1;
    }
    println!("=== outcome distribution over seeds 0..{seeds}: {outcomes:#?}");

    // The default range must actually reach every way a task can end, or the
    // invariants above would be checked on too little.
    if seeds >= DEFAULT_SEEDS && steps >= DEFAULT_STEPS {
        for outcome in [
            Outcome::Cancelled,
            Outcome::Approved,
            Outcome::ReviewExpired,
            Outcome::WorkDeadlineMissed,
            Outcome::NeverVerified,
            Outcome::DisputeResolvedForDeveloper,
            Outcome::DisputeResolvedForClient,
            Outcome::DisputeExpiredForDeveloper,
            Outcome::DisputeExpiredForClient,
        ] {
            assert!(
                outcomes.contains_key(&format!("{outcome:?}")),
                "no sequence ended with {outcome:?}: {outcomes:?}"
            );
        }
    }
}
