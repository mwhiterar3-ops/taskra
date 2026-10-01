# Taskra — Onchain Engineering Specification

## Goal

Implement one primary Anchor program responsible for the economically important task lifecycle and USDC escrow.

## Required lifecycle

The canonical lifecycle, state names and transition table are defined in
`13-DECISIONS.md` §2. On-chain states:

OPEN → ACCEPTED → SUBMITTED → (UNDER_REVIEW) → SETTLED

with the exceptional states DISPUTED, REFUNDED and CANCELLED. `DRAFT` exists only
in the database. `UNDER_REVIEW` exists only if the attester option in
`13-DECISIONS.md` §7 is approved.

Rejection/dispute must not allow arbitrary fund movement. Dispute resolution has
exactly two outcomes — full refund to the client or full payment to the developer
— plus a permissionless timeout fallback.

## Required instructions

The instruction set is defined in `13-DECISIONS.md` §3.9:

- initialize_platform
- update_platform
- create_task (creates and funds atomically; there is no separate fund_task)
- cancel_task
- accept_task
- submit_work
- approve_task (releases payment in the same instruction)
- reject_task (moves directly to DISPUTED; there is no separate open_dispute)
- expire_review
- refund_task
- resolve_dispute
- expire_dispute
- attest_verification (only if the attester option is approved)

Do not create extra instructions without a concrete reason.

## Accounts

The account and PDA table is defined in `13-DECISIONS.md` §3:

- Platform
- Task
- Escrow token account (authority: the Task PDA)
- Treasury token account
- Client and developer token accounts

A separate WorkRecord account was evaluated and is not recommended; the terminal
Task account is the work record (`13-DECISIONS.md` §3.7).

Reliability rewards are deferred from the MVP: there is no ReliabilityReserve
account and no reward instruction.

## Invariants

The program must enforce:

- only the correct client can fund their task
- only an eligible developer can accept (any wallet other than the task's client)
- only the accepted developer can submit
- only valid state transitions are possible
- escrow cannot be released twice
- settlement amount is deterministic: `fee = floor(amount * fee_bps / 10000)`, developer receives `amount - fee`
- deadlines are enforced
- review-window expiry is enforceable
- funds cannot be redirected to arbitrary accounts
- no private key is ever required by the program

## USDC

Do not hardcode a production mint into source code.

Use explicit environment/configuration for the target network and validate the mint against program expectations.

Use integer token base units. Never use floating-point arithmetic for money.

## Important

The account/PDA table and the instruction/state transition table in
`13-DECISIONS.md` must be approved before implementation. Do not invent them silently.
