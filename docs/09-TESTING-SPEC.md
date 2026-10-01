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
