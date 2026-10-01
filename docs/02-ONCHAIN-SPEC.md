# Taskra — Onchain Engineering Specification

## Goal

Implement one primary Anchor program responsible for the economically important task lifecycle and USDC escrow.

## Required lifecycle

The canonical lifecycle, state names and transition table are defined in
`13-DECISIONS.md` §2. On-chain states:

OPEN → ACCEPTED → SUBMITTED → UNDER_REVIEW → SETTLED

with the exceptional states DISPUTED, REFUNDED and CANCELLED. `DRAFT` exists only
in the database.

Rejection/dispute must not allow arbitrary fund movement. Dispute resolution has
exactly two outcomes — full refund to the client or full payment to the developer
— plus a permissionless, deterministic timeout fallback.

## Required instructions

The instruction set is defined in `13-DECISIONS.md` §3.7:

- initialize_platform
- rotate_keys
- create_and_fund_task (creates and funds atomically)
- cancel_task
- accept_task
- submit_work
- record_attestation
- approve_task (releases payment in the same instruction)
- reject_task (moves directly to DISPUTED)
- open_developer_dispute
- expire_review
- refund_expired
- resolve_dispute
- expire_dispute

Do not create extra instructions without a concrete reason.

## Accounts

The account and PDA table is defined in `13-DECISIONS.md` §3:

- Platform
- Task (the permanent on-chain work record; never closed)
- Escrow token account (authority: the Task PDA)
- Treasury token account
- Client and developer token accounts

There is no WorkRecord account, no attestation account and no ReliabilityReserve
account. Reliability rewards are deferred from the MVP.

## Invariants

The program must enforce:

- only the correct client can fund their task
- only an eligible developer can accept (any wallet other than the task's client)
- only the accepted developer can submit
- only the configured attester can record an attestation, and the attester can do nothing else
- an attestation applies only to the evidence hash and submission nonce it was issued for
- only valid state transitions are possible
- escrow cannot be released twice
- settlement amount is deterministic: `fee = floor(amount * fee_bps / 10000)`, developer receives `amount - fee`
- deadlines are enforced
- review-window expiry is enforceable
- funds cannot be redirected to arbitrary accounts
- escrow cannot be locked indefinitely
- no private key is ever required by the program

## USDC

Do not hardcode a production mint into source code.

Use explicit environment/configuration for the target network and validate the mint against program expectations.

Use integer token base units. Never use floating-point arithmetic for money.
