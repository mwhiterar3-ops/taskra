//! The evidence hash is an opaque 32-byte value to the program. These tests
//! show that it authorizes nothing by itself: money moves only through an
//! attestation bound to the task, the hash and the submission nonce (or
//! through the client's own approval or the authority's decision).
//!
//! The first tests pin the published hash test vectors of
//! docs/13-DECISIONS.md §5.3 and §10.3 with a reference encoder.

mod common;

use common::*;
use solana_signer::Signer;
use taskra::{
    error::TaskraError,
    state::{DisputeResolution, Outcome, TaskState},
};

const AMOUNT: u64 = 100 * USDC;
const HASH_X: [u8; 32] = [0x11; 32];
const HASH_Y: [u8; 32] = [0x22; 32];
const ARBITRARY: [u8; 32] = [0xEE; 32];

// --- reference encoder for the documented hash formats ---------------------

/// SHA-256 over `prefix || LP(field_1) || ... || LP(field_n)`, where
/// `LP(x)` is the 4-byte big-endian byte length of `x` followed by `x`.
fn domain_hash(prefix: &str, fields: &[&str]) -> String {
    let mut preimage = prefix.as_bytes().to_vec();
    for field in fields {
        preimage.extend_from_slice(&u32::try_from(field.len()).unwrap().to_be_bytes());
        preimage.extend_from_slice(field.as_bytes());
    }
    solana_sha256_hasher::hash(&preimage)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn evidence_hash(repo: &str, pr_number: u64, head_sha: &str) -> String {
    domain_hash(
        "taskra:evidence:v1",
        &[repo, &pr_number.to_string(), head_sha],
    )
}

/// `acceptance_criteria` must already be NFC-normalized and trimmed.
fn terms_hash(repo: &str, acceptance_criteria: &str, work_duration: u64, amount: u64) -> String {
    domain_hash(
        "taskra:terms:v1",
        &[
            repo,
            acceptance_criteria,
            &work_duration.to_string(),
            &amount.to_string(),
        ],
    )
}

#[test]
fn evidence_hash_test_vectors() {
    assert_eq!(
        evidence_hash(
            "octo-org/parser",
            42,
            "0123456789abcdef0123456789abcdef01234567"
        ),
        "926d8ba0f3545c78cdd042d93f7269e67a984224d834bce7a2f379a1303ceef1"
    );
    assert_eq!(
        evidence_hash("a/b", 1, "ffffffffffffffffffffffffffffffffffffffff"),
        "284d3265700774db64c4afa8da7fb252ca9979bbcab298cf379aed52b01791cf"
    );
    // One more commit on the PR changes the head SHA and therefore the hash.
    assert_eq!(
        evidence_hash(
            "octo-org/parser",
            42,
            "0123456789abcdef0123456789abcdef01234568"
        ),
        "96c47c4da14961d66d9bfd7844bce5ed80a4bfa7781a0fd29c149f5011749190"
    );
}

#[test]
fn terms_hash_test_vectors() {
    assert_eq!(
        terms_hash(
            "octo-org/parser",
            "Parses transaction signatures\nReturns structured output",
            172_800,
            100_000_000
        ),
        "30847829aaee28ae7add3254b2f0bf44a262467ed115d4f87d041bd53f50c066"
    );
    // The documented raw input "  Cafe\u{301} tests pass \n" normalizes to this
    // NFC, trimmed string (16 UTF-8 bytes).
    let normalized = "Caf\u{e9} tests pass";
    assert_eq!(normalized.len(), 16);
    assert_eq!(
        terms_hash("a/b", normalized, 1, 1),
        "f3bfcae9cdec77ec36a7223c7c8da9ce001e7d95a9ad72cbb10cd23d0130934c"
    );
}

#[test]
fn length_prefixes_keep_field_boundaries_unambiguous() {
    assert_ne!(
        domain_hash("taskra:evidence:v1", &["ab", "c"]),
        domain_hash("taskra:evidence:v1", &["a", "bc"])
    );
    // The same fields under the other domain prefix give a different hash.
    assert_ne!(
        domain_hash("taskra:evidence:v1", &["a/b", "1", "1"]),
        domain_hash("taskra:terms:v1", &["a/b", "1", "1"])
    );
}

// --- an attestation for X cannot settle Y ------------------------------------

#[test]
fn an_attestation_for_hash_x_cannot_settle_after_the_submission_becomes_y() {
    let mut env = Env::new();
    let attester = env.attester.insecure_clone();
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, HASH_X));
    ok(env.attest(&t));
    let old_review_deadline = env.task(&t).review_deadline;
    assert!(env.task(&t).has_valid_attestation());

    // The developer pushes another commit: the head SHA, and so the hash, changes.
    ok(env.submit(&t, HASH_Y));
    let task = env.task(&t);
    assert_eq!(task.state, TaskState::Submitted);
    assert_eq!(task.evidence_hash, HASH_Y);
    assert_eq!(task.submission_nonce, 2);
    assert!(!task.has_valid_attestation());

    // The attestation for X cannot be replayed onto Y, under either nonce.
    for nonce in [1, 2] {
        let replay = env.attest_ix(&t, &attester.pubkey(), HASH_X, nonce);
        assert!(env.send(&[replay], &[&attester]).is_err());
    }
    // A client approval built for X does not approve Y.
    let mut accounts = env.approve_accounts(&t);
    accounts.client = t.client.pubkey();
    let stale_approval = ix(
        accounts,
        taskra::instruction::ApproveTask {
            evidence_hash: HASH_X,
        },
    );
    fails_with(
        env.send(&[stale_approval], &[&t.client]),
        TaskraError::EvidenceMismatch,
    );

    // The review window that X started can never expire into a payment.
    for time in [
        old_review_deadline + 1,
        task.dispute_open_at + 1,
        task.refund_open_at + 30 * DAY,
    ] {
        env.set_time(time);
        fails_with(env.expire_review(&t), TaskraError::InvalidState);
        assert_eq!(env.balances(&t).escrow, AMOUNT);
    }

    // With Y never attested, the task ends in a client refund.
    ok(env.refund_expired(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);
}

#[test]
fn the_dispute_fallback_ignores_an_attestation_for_a_superseded_hash() {
    let mut env = Env::new();
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, HASH_X));
    ok(env.attest(&t));
    ok(env.submit(&t, HASH_Y));

    env.set_time(env.task(&t).dispute_open_at + 1);
    ok(env.developer_dispute(&t));
    env.set_time(env.task(&t).dispute_deadline + 1);
    ok(env.expire_dispute(&t));

    // X was verified once, but Y is the current submission and was not.
    assert_eq!(env.task(&t).outcome, Outcome::DisputeExpiredForClient);
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);
}

#[test]
fn resubmitting_the_same_hash_still_requires_a_fresh_attestation() {
    let mut env = Env::new();
    let attester = env.attester.insecure_clone();
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, HASH_X));
    ok(env.attest(&t));
    let review_deadline = env.task(&t).review_deadline;

    // X -> Y -> X: the hash is X again, but it is submission 3, not 1.
    ok(env.submit(&t, HASH_Y));
    ok(env.submit(&t, HASH_X));
    assert!(!env.task(&t).has_valid_attestation());
    let replay = env.attest_ix(&t, &attester.pubkey(), HASH_X, 1);
    fails_with(
        env.send(&[replay], &[&attester]),
        TaskraError::NonceMismatch,
    );
    env.set_time(review_deadline + 1);
    fails_with(env.expire_review(&t), TaskraError::InvalidState);
    assert_eq!(env.balances(&t).escrow, AMOUNT);
}

// --- an arbitrary hash yields delay, never payment -----------------------------

#[test]
fn an_arbitrary_unattested_hash_never_pays_the_developer_by_itself() {
    let mut env = Env::new();
    let stranger = env.wallet(0);
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, ARBITRARY));
    let task = env.task(&t);

    // Across the whole SUBMITTED timeline, nothing the developer or a
    // bystander can sign moves a single token to the developer.
    for time in [
        env.now(),
        task.work_deadline + 1,
        task.verification_deadline + 1,
        task.dispute_open_at,
        task.dispute_open_at + 1,
    ] {
        env.set_time(time);
        assert!(env.expire_review(&t).is_err());
        assert!(env.expire_dispute(&t).is_err());
        // The developer cannot approve their own work or attest it.
        let mut accounts = env.approve_accounts(&t);
        accounts.client = t.developer.pubkey();
        let self_approval = ix(
            accounts,
            taskra::instruction::ApproveTask {
                evidence_hash: ARBITRARY,
            },
        );
        fails_with(
            env.send(&[self_approval], &[&t.developer]),
            TaskraError::Unauthorized,
        );
        for wallet in [&t.developer, &stranger] {
            let self_attest = env.attest_ix(&t, &wallet.pubkey(), ARBITRARY, 1);
            fails_with(
                env.send(&[self_attest], &[wallet]),
                TaskraError::Unauthorized,
            );
        }
        assert_eq!(env.balances(&t).developer, 0);
        assert_eq!(env.balances(&t).escrow, AMOUNT);
    }

    // Escalating only delays: with no attestation the fallback refunds the client.
    ok(env.developer_dispute(&t));
    let dispute_deadline = env.task(&t).dispute_deadline;
    for time in [env.now(), dispute_deadline] {
        env.set_time(time);
        assert!(env.expire_dispute(&t).is_err());
        assert!(env.expire_review(&t).is_err());
        fails_with(env.attest(&t), TaskraError::InvalidState);
        assert_eq!(env.balances(&t).developer, 0);
    }
    env.set_time(dispute_deadline + 1);
    ok(env.expire_dispute(&t));
    assert_eq!(env.balances(&t).client, AMOUNT);
    assert_eq!(env.balances(&t).developer, 0);
    assert_eq!(env.balances(&t).treasury, 0);
}

#[test]
fn an_unattested_hash_pays_only_by_client_approval_or_authority_decision() {
    let mut env = Env::new();

    // The client's own signature.
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, ARBITRARY));
    ok(env.approve(&t));
    assert_eq!(env.task(&t).outcome, Outcome::Approved);
    assert_eq!(env.balances(&t).developer, 97_500_000);

    // The platform authority's decision in a dispute.
    let t = env.accepted_task(AMOUNT);
    ok(env.submit(&t, ARBITRARY));
    env.set_time(env.task(&t).dispute_open_at + 1);
    ok(env.developer_dispute(&t));
    ok(env.resolve(&t, DisputeResolution::PayDeveloper));
    assert_eq!(env.task(&t).outcome, Outcome::DisputeResolvedForDeveloper);
    assert_eq!(env.balances(&t).developer, 97_500_000);
}
