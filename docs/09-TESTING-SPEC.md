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

## What exists

| Suite | Where | Real | Replaced |
|---|---|---|---|
| Program | `programs/taskra/tests` (`pnpm anchor:test`) | The compiled program on LiteSVM, with clock control | — |
| SDK | `packages/sdk` (`pnpm test`) | — | — |
| SDK validator loop | `pnpm sdk:validator-loop` | `solana-test-validator`, SPL mint | — |
| API | `apps/api/src/**/*.test.ts` | The Fastify app, PostgreSQL, role privileges | The chain (`testing/fake-chain.ts`), GitHub, the clock |
| Database | `apps/api/src/db.test.ts` | PostgreSQL: migrations up and down, privileges per role, triggers, constraints | — |
| Attestation service | `apps/attester/src/**/*.test.ts` | PostgreSQL, the real signer and its signatures | The chain (a fake that applies `record_attestation` like the program), GitHub, the clock |
| Web | `apps/web/src/**/*.test.{ts,tsx}` | The transaction state machine, action rules, wallet/session provider (jsdom) | The wallet (a keypair-backed fake), the RPC endpoint, the API |
| End to end | `apps/e2e` (`pnpm e2e`) | Validator, program, PostgreSQL with one login per service, the API over HTTP, the attestation service, the real service processes | GitHub only |

Time: unit suites inject the clock. The end-to-end run uses a short-window test
profile and waits on the **cluster clock** or on an observable condition
(finality, a verification result); it contains no fixed sleeps standing in for
a condition. Protocol timing is never changed to make a test pass.

### Coverage by concern

| Concern | Tested in |
|---|---|
| Sign-in success; wrong key; altered message; replayed, concurrent, expired and unknown nonce | `auth.test.ts` |
| Session expiry, logout, forged cookie; wallet-in-body is not identity; cross-origin writes refused | `auth.test.ts` |
| Duplicate and concurrent transaction reports; wrong program, task or instruction; unknown signature | `tasks.test.ts`, e2e C |
| Confirmed but not finalized; finalization; failed and dropped transactions | `tasks.test.ts`, e2e A |
| Settlement recorded once under concurrency; found without a report; amounts that do not add up | `tasks.test.ts`, e2e B |
| RPC unavailable: 503 on writes, cache on reads, retry policy | `tasks.test.ts`, `chain.test.ts` |
| Stale or tampered metadata; on-chain/database mismatch | `tasks.test.ts`, `rules.test.ts`, e2e F |
| Database rollback, constraints, append-only audit rows, role isolation | `db.test.ts` |
| Valid submission; every rule R1–R9; changed head; deleted repository | `rules.test.ts`, `worker.test.ts`, e2e A/E |
| GitHub outage, timeout, rate limit, malformed response | `github.test.ts`, `worker.test.ts`, e2e E |
| Duplicate, replayed and concurrent verification jobs; superseded submission | `worker.test.ts`, e2e F |
| Attestation retry, dropped and refused sends, crash before send, key rotated | `worker.test.ts` |
| Signing key isolation (API cannot sign; signer signs one instruction) | `app.test.ts`, `signer.test.ts`, e2e G |
| Wallet connect and rejection, sign-in, reload and reconnect | `app-context.test.tsx` |
| Transaction success, rejection, insufficient funds, program error, expiry, lost RPC | `transaction.test.ts` |
| Which actions are offered when; no conflicting outcomes offered at once | `actions.test.ts` |
| Program: invalid transitions, unauthorized calls, wrong accounts, insufficient balance | `programs/taskra/tests`, e2e A/C |

`scripts/mutation-check.sh` (program) and `scripts/mutation-check-services.sh`
(API, attestation service, web logic) seed defects one at a time and fail unless
the suites catch each one.

### Not covered

- No GitHub webhooks exist (`13-DECISIONS.md` §13), so there is no webhook test;
  repeated *jobs* are the equivalent and are tested.
- The web app is not tested in a real browser with a wallet extension. Its
  components beyond the wallet panel have no rendering tests; their logic is in
  the tested modules above.
- The real GitHub API and OAuth service are never contacted by a test.
- Nothing is tested on devnet.
