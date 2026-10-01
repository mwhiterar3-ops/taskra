# Taskra — Testing Specification

The critical economic loop must be tested.

## Anchor tests

Every transition in `13-DECISIONS.md` §2.3 must have a test. Tests use a local
test mint and clock warping. Test:

- create task (atomic create + fund)
- cancel before acceptance
- accept task
- submit work and resubmit work
- attestation, unauthorized attester, stale attestation after resubmission
- approve
- settlement, including the exact fee and developer amounts
- zero-fee settlement
- review expiry
- rejection
- developer dispute
- dispute resolution: refund and payment
- dispute timeout fallback, both branches
- missed work deadline refund and unverified-submission refund
- invalid state transitions
- unauthorized actions
- double settlement attempts across every settlement path
- wrong developer
- wrong client
- wrong mint and wrong token account
- authority attempting a third-party destination
- deadline boundaries
- every mutual-exclusion case in `13-DECISIONS.md` §2.6
- key rotation
- the worst-case client-fund lock against the formula in `13-DECISIONS.md` §2.7
- the published hash test vectors (`13-DECISIONS.md` §5.3, §10.3)
- an attestation for one evidence hash cannot settle another
- the fee is charged on the principal only; stray deposits follow the principal

Randomized sequences (random instructions, signers and clock advances) must hold
these invariants after every step: escrow equals the task amount, or the task is
terminal with escrow closed; total tokens paid out never exceed the amount; at
most one terminal outcome occurs. A fixed seed always runs, plus a seed range
sized by `TASKRA_FUZZ_SEEDS` / `TASKRA_FUZZ_STEPS`.

`scripts/mutation-check.sh` seeds eight defects into the program one at a time;
the suite must catch every one.

Reliability rewards are deferred from the MVP, so there is no reward-cap test.

## Backend tests

Test:
- wallet authentication
- authorization
- task creation/retrieval
- evidence submission
- GitHub verification
- settlement indexing
- reputation aggregation
- idempotent event processing

## End-to-end

The target scenario is:

Client wallet
→ create task
→ fund 100 USDC
→ developer wallet
→ accept
→ submit GitHub evidence
→ verification
→ client approval
→ developer receives 97.50 USDC; treasury receives 2.50 USDC
→ settlement record
→ reputation update

Critical blockchain steps must be real in the demo environment.

Mocks are acceptable only inside automated tests.
