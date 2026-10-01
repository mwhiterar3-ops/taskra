# Taskra — Testing Specification

The critical economic loop must be tested.

## Anchor tests

Every transition in `13-DECISIONS.md` §2.2 must have a test. Test:
- create task (atomic create + fund)
- cancel before acceptance
- accept task
- submit work
- resubmit work
- approve
- settlement, including the exact fee and developer amounts
- review expiry
- rejection
- dispute resolution: refund and payment
- dispute timeout fallback
- missed work deadline refund
- invalid state transitions
- unauthorized actions
- double settlement
- wrong developer
- wrong client
- wrong mint and wrong destination token account
- deadline violations

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
