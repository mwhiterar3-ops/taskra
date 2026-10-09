# Taskra — Decisions, Canonical State Machine and Account Model

This document is the single authoritative definition of the task lifecycle, the
on-chain account model and the engineering decisions for Taskra. Where it
conflicts with any other document in `docs/`, this document wins; the other
documents have been amended to match.

All decisions below are **LOCKED** by the project owner. §13 lists reversible
implementation details chosen under the owner's delegated judgment.

---

## 1. Decision log

| # | Topic | Decision |
|---|---|---|
| D1 | Fee | 2.5%, stored as `fee_bps = 250` in Platform config. `fee = floor(amount * fee_bps / 10000)`; the developer receives `amount - fee`; the fee goes to the configured treasury token account. Checked integer arithmetic in token base units only. |
| D2 | Verification | **Option B.** A platform attester records verification on-chain. The attester can write an attestation and nothing else. The attestation binds to the task, its `evidence_hash` and its submission nonce. The review window begins only at a valid VERIFIED attestation. See §7. |
| D3 | Work deadline | `work_deadline = accepted_at + work_duration`, with `work_duration` set by the client at creation. |
| D4 | Verification grace | 24 hours, stored in Platform config, never hardcoded. |
| D5 | Dispute | Rejection enters `DISPUTED`. Exactly two outcomes: full refund to the client, or full payment to the developer (fee applies). No split. The authority can never send funds to any account except the task's recorded client or developer token accounts. |
| D6 | Dispute timeout | 7 days, stored in Platform config. After the timeout a permissionless fallback pays the developer **only if** a VERIFIED attestation exists for the task's current `evidence_hash` and submission nonce; otherwise it refunds the client. |
| D7 | Valid submission | The GitHub PR verification rules in §10. PR evidence only. |
| D8 | Client inaction | Must not lock escrow indefinitely. The developer may move `SUBMITTED` to `DISPUTED` after the review window passes with no client action (exact preconditions in §2.4). Mutual exclusion of all outcome paths is proven in §2.6 and tested. |
| D9 | Accept-squatting | Documented MVP limitation. No mitigation is built. The client-set `work_duration` bounds the damage. |
| D10 | Minimum amount | `amount > 0` only. A task whose fee floors to zero must settle correctly. |
| D11 | Terms hash | SHA-256 over the domain-separated encoding of `{repo, acceptance_criteria, work_duration, amount}` with prefix `taskra:terms:v1`, stored on-chain at creation (§5.3). Full metadata stays off-chain. |
| D12 | Work record | No separate WorkRecord. The Task account is the on-chain record and is never closed. |
| D13 | Task ID | 16-byte UUID (§5.1). |
| D14 | Keys | Platform authority, attester and treasury are three separate keys. Platform authority and program upgrade authority are separate keys. Never store user private keys or seed phrases. No privileged backend key beyond the approved attester. Development credentials are devnet/test only. |
| D15 | Reliability rewards | Deferred. No reserve account, no reward code. The "Reliable Contributor" milestone is computed off-chain and labelled **Off-chain aggregate**. |
| D16 | Review window | One global Platform value, default 48 hours, set in `initialize_platform`, never hardcoded in instruction logic. |
| D17 | Confirmation policy | `confirmed` for UI progress; `finalized` before the backend records a financial settlement as authoritative (§11). |
| D18 | Create + fund | One atomic on-chain operation. Unfunded tasks do not exist on-chain; drafts exist only in the database (§4). |
| D19 | Product defaults | Next.js web; separate Node.js/TypeScript API; pnpm monorepo; one wallet identity per user; any wallet other than the task client may accept; GitHub pull requests are the only MVP evidence type; the client names the target repository at task creation. |
| D20 | Toolchain | Ubuntu on WSL; repository at `~/taskra`; versions pinned in §12. |
| D21 | Evidence hash | SHA-256 over the domain-separated, fixed-field-order encoding of `{repo, pr_number, head_sha}` with prefix `taskra:evidence:v1` (§10.3). This replaces `merge_commit_sha` everywhere. `submit_work` stays generic: any non-zero hash. |
| D22 | Developer-dispute timing | Unchanged after review. A developer who submits junk can delay the client's refund but can never be paid by it; the bound and the rationale are in §2.7. An attester "REJECTED" record is **not** implemented and would need explicit approval. |
| D23 | Deploy profiles | Time windows are deploy-time configuration, immutable after `initialize_platform`. Production and devnet-demo values are in §15. |

---

## 2. Canonical task lifecycle

One set of state names is used by the product specification, the Anchor program,
the API, the database and the frontend.

### 2.1 States

| State | Exists | Meaning | Terminal |
|---|---|---|---|
| `DRAFT` | Database only | Task metadata saved; nothing on-chain; no funds. | No |
| `OPEN` | On-chain | Task account exists and the full amount is in escrow; awaiting a developer. | No |
| `ACCEPTED` | On-chain | A developer is recorded; the work deadline is running. | No |
| `SUBMITTED` | On-chain | The developer has recorded an evidence hash; no valid attestation exists for it. | No |
| `UNDER_REVIEW` | On-chain | A VERIFIED attestation exists for the current evidence hash and nonce; the client review window is running. | No |
| `DISPUTED` | On-chain | The client rejected, or the developer escalated; awaiting the authority or the timeout fallback. | No |
| `SETTLED` | On-chain | Escrow paid to the developer (minus fee). | Yes |
| `REFUNDED` | On-chain | Escrow returned in full to the client after acceptance. | Yes |
| `CANCELLED` | On-chain | Client cancelled before acceptance; escrow returned in full. | Yes |

Names that are **not** states: `CREATE` and `FUNDED` (creation and funding are
atomic, so a funded task is `OPEN`); `APPROVED`, `REVIEW EXPIRES` and `REJECTED`
(transitions).

### 2.2 Times

All times are the on-chain clock (`Clock::unix_timestamp`, UTC seconds). Platform
values: `review_window` (48 h), `verification_grace` (24 h), `dispute_timeout`
(7 d). They are set once in `initialize_platform` and cannot be changed
afterwards, so a funded task's terms can never shift.

| Name | Set by | Value |
|---|---|---|
| `work_deadline` | `accept_task` | `accepted_at + work_duration` |
| `verification_deadline` | `accept_task` | `work_deadline + verification_grace` |
| `dispute_open_at` | `submit_work` | `max(verification_deadline, submitted_at + review_window)` |
| `refund_open_at` | `submit_work` | `dispute_open_at + review_window` |
| `review_deadline` | `record_attestation` | `verified_at + review_window` |
| `dispute_deadline` | entering `DISPUTED` | `disputed_at + dispute_timeout` |

Boundary convention: the party bound by a deadline may act while
`now ≤ deadline`; the remedy that follows it opens when `now > deadline`. The two
are never valid at the same timestamp.

### 2.3 Transition table

| # | State | Actor | Action | Preconditions | Next State | Fund Movement |
|---|---|---|---|---|---|---|
| T0 | — | Client | API: create draft | Authenticated wallet session | `DRAFT` | None |
| T1 | `DRAFT` | Client | `create_and_fund_task` | `amount > 0`; `work_duration > 0`; terms hash non-zero; Task PDA does not exist; source holds `amount` of the configured mint | `OPEN` | Client → escrow: `amount` |
| T2 | `OPEN` | Client | `cancel_task` | Signer is `task.client` | `CANCELLED` | Escrow → client: full balance |
| T3 | `OPEN` | Developer | `accept_task` | Signer ≠ `task.client` | `ACCEPTED` | None |
| T4 | `ACCEPTED` | Developer | `submit_work` | Signer is `task.developer`; `now ≤ work_deadline`; evidence hash non-zero | `SUBMITTED` | None |
| T5 | `SUBMITTED` or `UNDER_REVIEW` | Developer | `submit_work` (resubmission) | Same as T4. Increments the nonce and voids any attestation. | `SUBMITTED` | None |
| T6 | `SUBMITTED` | Attester | `record_attestation` | Signer is `platform.attester`; supplied hash and nonce equal the task's current ones; `now ≤ verification_deadline` | `UNDER_REVIEW` | None |
| T7 | `ACCEPTED` | Client | `refund_expired` | Signer is `task.client`; `now > work_deadline` | `REFUNDED` | Escrow → client: full balance |
| T8 | `SUBMITTED` | Client | `refund_expired` | Signer is `task.client`; `now > refund_open_at` | `REFUNDED` | Escrow → client: full balance |
| T9 | `SUBMITTED`, or `UNDER_REVIEW` with `now ≤ review_deadline` | Client | `approve_task` | Signer is `task.client`; supplied hash equals `task.evidence_hash` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T10 | `UNDER_REVIEW` | Client | `reject_task` | Signer is `task.client`; `now ≤ review_deadline`; reason hash non-zero | `DISPUTED` | None |
| T11 | `UNDER_REVIEW` | Anyone | `expire_review` | `now > review_deadline` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T12 | `SUBMITTED` | Developer | `open_developer_dispute` | Signer is `task.developer`; `dispute_open_at < now ≤ refund_open_at` | `DISPUTED` | None |
| T13 | `DISPUTED` | Platform authority | `resolve_dispute(PayDeveloper)` | Signer is `platform.authority`; `now ≤ dispute_deadline` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T14 | `DISPUTED` | Platform authority | `resolve_dispute(RefundClient)` | Signer is `platform.authority`; `now ≤ dispute_deadline` | `REFUNDED` | Escrow → client: full balance |
| T15 | `DISPUTED` | Anyone | `expire_dispute` | `now > dispute_deadline`; a valid attestation exists | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T16 | `DISPUTED` | Anyone | `expire_dispute` | `now > dispute_deadline`; no valid attestation exists | `REFUNDED` | Escrow → client: full balance |

A **valid attestation** exists when `verified_at ≠ 0`, `attested_nonce ==
submission_nonce` and `attested_hash == evidence_hash`.

### 2.4 Developer dispute — exact preconditions (D8)

`open_developer_dispute` succeeds only when all of the following hold:

1. The task is `SUBMITTED` (the developer submitted on time and no valid
   attestation exists for the current submission).
2. The signer is `task.developer`.
3. `now > dispute_open_at`, where
   `dispute_open_at = max(verification_deadline, submitted_at + review_window)`.
   This means both that the attester's window has closed and that a full review
   window has passed since the submission with no client action.
4. `now ≤ refund_open_at`, where `refund_open_at = dispute_open_at + review_window`.

After `refund_open_at` the developer's escalation right has lapsed and the client
may take a refund (T8). The attester's window (`≤ verification_deadline`), the
developer's window and the client's refund window are therefore disjoint in time.

A task that reaches `DISPUTED` this way has no valid attestation. The authority
may still resolve it either way on the merits; if the authority does nothing, the
fallback refunds the client (T16). Escrow is never locked: every non-terminal
state has a transition to a terminal state that becomes available by a fixed
time with no action required from the other party.

### 2.5 Where funds go, and why double settlement is impossible

Common to every fund-moving transition (T2, T7, T8, T9, T11, T13–T16):

- The instruction requires one specific non-terminal source state, writes a
  terminal state, transfers the **entire** escrow balance and closes the escrow
  token account, in one atomic transaction. A second call fails twice over: the
  state check no longer holds, and the escrow account no longer exists.
- Destinations are never free parameters. They are the associated token accounts
  of `task.client` or `task.developer` for the configured mint, or the address in
  `platform.treasury`.
- The attester signs none of them.

| # | Authorization | Funds go to | Fee | Terminal | Why it cannot double-settle |
|---|---|---|---|---|---|
| T0 | API session of the client wallet | — | — | No | No funds exist. |
| T1 | Client signs; pays rent for Task and escrow | Escrow token account (PDA) | None | No | The Task PDA is created with `init`; the same `(client, task_id)` cannot be created twice. |
| T2 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `OPEN`; writes `CANCELLED`; closes escrow. |
| T3 | Any signer ≠ client | — | — | No | No funds move. `OPEN` cannot recur. |
| T4, T5 | `signer == task.developer` | — | — | No | No funds move. |
| T6 | `signer == platform.attester` | — | — | No | No funds move; the instruction has no token accounts. |
| T7 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `ACCEPTED`; writes `REFUNDED`; closes escrow. |
| T8 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `SUBMITTED`; writes `REFUNDED`; closes escrow. |
| T9 | `signer == task.client` | Treasury; developer USDC ATA | `fee` on `task.amount` at `task.fee_bps` | Yes | Requires `SUBMITTED`/`UNDER_REVIEW`; writes `SETTLED`; closes escrow. |
| T10 | `signer == task.client` | — | — | No | No funds move. |
| T11 | Permissionless | Treasury; developer USDC ATA | As T9 | Yes | Requires `UNDER_REVIEW`; writes `SETTLED`; closes escrow. |
| T12 | `signer == task.developer` | — | — | No | No funds move. |
| T13 | `signer == platform.authority` | Treasury; developer USDC ATA | As T9 | Yes | Requires `DISPUTED`; writes `SETTLED`; closes escrow. |
| T14 | `signer == platform.authority` | Client USDC ATA | None | Yes | Requires `DISPUTED`; writes `REFUNDED`; closes escrow. |
| T15 | Permissionless | Treasury; developer USDC ATA | As T9 | Yes | Requires `DISPUTED`; writes `SETTLED`; closes escrow. |
| T16 | Permissionless | Client USDC ATA | None | Yes | Requires `DISPUTED`; writes `REFUNDED`; closes escrow. |

Notes:

- **T5 resubmission** is allowed until the work deadline, including after an
  attestation. It increments `submission_nonce`, clears the attestation fields and
  returns the task to `SUBMITTED`, so an attestation can never apply to evidence
  it was not issued for.
- **T9 hash argument.** The client passes the evidence hash they reviewed. If the
  developer resubmits different evidence first, the approval fails.
- **T9 from `SUBMITTED`.** The client may approve their own task without an
  attestation; attester downtime can never stop a willing client from paying.
- **T10 reason hash.** The rejection reason is stored off-chain; its SHA-256 is
  recorded on-chain so it cannot be changed afterwards.
- **Fee of zero.** When `fee` floors to zero the treasury account is still
  required and validated, no fee transfer is made, and the developer receives the
  whole balance.

### 2.6 Proof that outcome paths are mutually exclusive (D8)

Claim: no sequence of instructions produces two outcomes or two transfers for one
task, and at no instant can two different parties force different fund outcomes.

**Part 1 — at most one outcome ever.** Let the *outcome instructions* be those in
§2.5 that move funds out of escrow. Each (a) checks that the task is in a
non-terminal state, (b) writes a terminal state, and (c) closes the escrow
account, atomically. No instruction leaves a terminal state: every instruction
checks for a specific non-terminal source state. Therefore after the first
outcome instruction succeeds, every later instruction fails at (a). Within one
transaction containing two outcome instructions, the second sees the state the
first wrote and fails, which reverts the whole transaction. ∎

**Part 2 — which outcome instructions are enabled when.** For each non-terminal
state, the table lists every enabled instruction by time interval. `W` =
`work_deadline`, `V` = `verification_deadline`, `D` = `dispute_open_at`, `R` =
`refund_open_at`, `RD` = `review_deadline`, `DD` = `dispute_deadline`. Outcome
instructions are in **bold**.

| State | Interval | Enabled instructions |
|---|---|---|
| `OPEN` | always | **`cancel_task`** (client), `accept_task` (developer) |
| `ACCEPTED` | `now ≤ W` | `submit_work` (developer) |
| `ACCEPTED` | `now > W` | **`refund_expired`** (client) |
| `SUBMITTED` | always | **`approve_task`** (client) |
| `SUBMITTED` | `now ≤ W` | `submit_work` (developer) |
| `SUBMITTED` | `now ≤ V` | `record_attestation` (attester) |
| `SUBMITTED` | `D < now ≤ R` | `open_developer_dispute` (developer) |
| `SUBMITTED` | `now > R` | **`refund_expired`** (client) |
| `UNDER_REVIEW` | `now ≤ W` | `submit_work` (developer) |
| `UNDER_REVIEW` | `now ≤ RD` | **`approve_task`** (client), `reject_task` (client) |
| `UNDER_REVIEW` | `now > RD` | **`expire_review`** (anyone) |
| `DISPUTED` | `now ≤ DD` | **`resolve_dispute`** (authority) |
| `DISPUTED` | `now > DD` | **`expire_dispute`** (anyone) |

Reading the bold entries:

- `OPEN`, `ACCEPTED`: one outcome instruction, one signer.
- `SUBMITTED`: `approve_task` and `refund_expired` are both signed by the client
  only, so the choice between paying and refunding belongs to one party; no other
  party can force an outcome. Because `V ≤ D < R`, the attester window, the
  developer-dispute window and the client-refund window do not overlap.
- `UNDER_REVIEW`: `approve_task` (`≤ RD`) and `expire_review` (`> RD`) are
  disjoint in time, and both pay the developer.
- `DISPUTED`: `resolve_dispute` (`≤ DD`) and `expire_dispute` (`> DD`) are
  disjoint in time. `expire_dispute` chooses its branch from on-chain state alone
  (valid attestation or not), so its result does not depend on the caller.

So refund paths, `expire_review`, developer dispute, authority resolution and the
timeout fallback are pairwise exclusive: any two of them either require different
states, or disjoint time intervals, or the same single signer. Combined with
Part 1, no interleaving yields a double outcome or a double transfer. ∎

The tests in `programs/taskra/tests` exercise each pair at its boundary.

### 2.7 Client-fund lock under the junk-submission path (D22)

**The attack.** A developer accepts a task, submits a meaningless hash, and
stalls: no attestation is produced, the client does nothing, and the developer
opens the dispute path only to delay the refund.

**Timeline, derived from the program.** `A` = `accepted_at`, `WD` =
`work_duration`, `G` = `verification_grace`, `RW` = `review_window`, `T` =
`dispute_timeout`, `S` = time of the (last) submission. Production values:
`G` = 24 h, `RW` = 48 h, `T` = 7 d.

| Quantity | Formula | Set in |
|---|---|---|
| Work deadline `W` | `A + WD` | `accept_task` |
| Verification deadline `V` | `W + G` | `accept_task` |
| Developer dispute opens after `D` | `max(S + RW, V)` | `submit_work` |
| Developer dispute closes at, client refund opens after `R` | `D + RW` | `submit_work` |
| Dispute deadline `DD` | `disputed_at + T` | `open_developer_dispute` |

`submit_work` requires `S ≤ W`, and every resubmission recomputes `D` and `R`
from the new `S`, so the latest possible values are reached with `S = W`.

| Scenario | Client funds recoverable from | Production |
|---|---|---|
| (i) Junk submitted at the work deadline (`S = W`), no escalation | `R + 1 s` = `W + max(RW, G) + RW + 1 s` | `W + 96 h` |
| (ii) Junk submitted early (`S + RW ≤ V`), no escalation or resubmission | `R + 1 s` = `W + G + RW + 1 s` | `W + 72 h` |
| (iii) Junk at the deadline, developer escalates at the last second (`disputed_at = R`), authority absent | `DD + 1 s` = `W + max(RW, G) + RW + T + 1 s` | `W + 11 d` |

In (i) and (ii) the client signs `refund_expired`. In (iii) anyone may call
`expire_dispute`, which refunds the client because no valid attestation exists.

**Maximum client-fund lock.** Measured from acceptance, with every other party
absent:

```text
max_lock = work_duration + max(review_window, verification_grace) + review_window + dispute_timeout
```

The funds are recoverable one second after `accepted_at + max_lock`. With
production values this is `work_duration + 11 days`. The bound is tight (scenario
iii reaches it) and cannot be exceeded:

- Before acceptance there is no lock; the client can cancel at any time.
- Resubmission is impossible after `W`, so `R` cannot move past
  `W + max(RW, G) + RW`.
- The developer dispute is **one-shot**. `DISPUTED` has no transition back to
  `SUBMITTED`, and `submit_work` is rejected in `DISPUTED`, so the dispute cannot
  be reopened, extended or repeated.
- The platform authority can end the dispute earlier with `resolve_dispute`. The
  `dispute_timeout` term applies only when the authority is absent as well.

**Junk and "client refuses to merge" are indistinguishable on-chain.** In both
cases the task is `SUBMITTED` with a non-zero hash and no attestation; the
program sees nothing else. A rule that refunds the junk case sooner would refund
the unmerged-but-genuine case sooner too. The delay is therefore the price of
giving an honest developer, whose finished work the client will not merge, time
to escalate and a chance to be heard by the authority.

**The attack yields delay only.** From `SUBMITTED` without a valid attestation,
the developer can be paid in exactly two ways, and neither is under the
developer's control: the client signs `approve_task`, or the platform authority
signs `resolve_dispute(PayDeveloper)`. `expire_review` requires `UNDER_REVIEW`,
which requires an attestation. `expire_dispute` pays the developer only with a
valid attestation and otherwise refunds the client. The junk submitter spends
transaction fees, gains nothing, and ends with a public on-chain record of a
task refunded as `NeverVerified` or `DisputeExpiredForClient`.

**Options evaluated.**

| Option | Result |
|---|---|
| One-shot developer dispute | Already true of the state machine (above). No change needed. |
| Shorter windows through deploy configuration | Supported today: all three windows are `initialize_platform` arguments. Shortening `dispute_timeout` reduces `max_lock` one-for-one; shortening `review_window` reduces it two-for-one. See §15. No code change. |
| Shorter developer-dispute window (for example `verification_grace` instead of `review_window`) | Would cut 24 h from the production bound but also from an honest developer's time to react. Not adopted; the locked windows stand. |
| Attester "REJECTED" record | **Not implemented. Needs explicit approval.** See below. |

**Attester "REJECTED" record (option only).** The attester would be allowed to
record that the current submission failed verification, and that record would
open the client's refund immediately instead of after `R`. It would reduce the
junk-path lock to roughly `work_duration + verification_grace`.

It is a new attester power. Today a stolen or misbehaving attester key can only
start a review window that the client can still reject. With a REJECTED record,
the same key could close the developer's dispute path: an attester colluding
with a client, a compromised key, or a verifier bug that misreads a GitHub
outage, could mark genuine work rejected and let the client take an immediate
refund with no recourse to the authority. That contradicts the locked property
that the attester writes an attestation and nothing else, and that its
compromise cannot cause funds to leave escrow. It is recorded here as an option
and nothing more.

**Decision.** The implementation is unchanged. `client_lock.rs` computes the
worst case from the program for three window profiles and asserts it equals
`max_lock` above, to the second.

---

## 3. Account and PDA model

All accounts are owned by the Taskra program unless stated. The token program is
the classic SPL Token program (the owner of the USDC mint); Token-2022 accounts
are rejected by type.

### 3.1 Platform

| Attribute | Value |
|---|---|
| Purpose | Singleton configuration: keys, mint, fee, time windows. |
| Seeds | `["platform"]` |
| Bump | Canonical bump stored in the account and re-checked on every use. |
| Owner | Taskra program |
| Fields | `authority`, `attester`, `treasury` (USDC token account address), `usdc_mint`, `fee_bps: u16`, `review_window: i64`, `verification_grace: i64`, `dispute_timeout: i64`, `bump` |
| Payer | Signer of `initialize_platform` |
| Initialization | `initialize_platform`, once. The signer must be the program's **upgrade authority**, checked against the program's ProgramData account, so nobody can front-run initialization. Validates `fee_bps ≤ 10000`, positive windows, the treasury's mint, and key separation (below). |
| Mutability | `authority`, `attester` and `treasury` change only through `rotate_keys`, signed by the current `authority`. Every other field is immutable. |
| Close | Never. |
| Invoked by | Read by every instruction. Written only by `initialize_platform` and `rotate_keys`. |

Key separation enforced on-chain at initialization and at every rotation:
`authority ≠ attester`; the treasury token account's owner is neither `authority`
nor `attester`; `authority` is not the program's upgrade authority.

### 3.2 Task

| Attribute | Value |
|---|---|
| Purpose | Economically relevant task state. After a terminal transition it is the permanent verified-work record (D12). |
| Seeds | `["task", client_pubkey, task_id]`, `task_id` being 16 raw bytes (§5.1). |
| Bump | Stored in the account and re-checked on every use. |
| Owner | Taskra program |
| Fields | `task_id`, `client`, `developer`, `amount: u64`, `fee_bps: u16` (copied at creation), `terms_hash: [u8; 32]`, `state`, `outcome`, `work_duration`, `created_at`, `accepted_at`, `work_deadline`, `verification_deadline`, `submission_nonce: u64`, `evidence_hash: [u8; 32]`, `submitted_at`, `dispute_open_at`, `refund_open_at`, `attested_nonce: u64`, `attested_hash: [u8; 32]`, `verified_at`, `review_deadline`, `disputed_at`, `dispute_deadline`, `rejection_reason_hash: [u8; 32]`, `closed_at`, `bump`, `escrow_bump` |
| Authority | The Task PDA is the authority of its escrow token account. |
| Payer | Client, in `create_and_fund_task`. |
| Initialization | `create_and_fund_task` only (`init`; fails if the PDA exists). |
| Mutability | Only through the transitions in §2.3. |
| Close | **Never.** |
| Constraints | Seeds + bump; `task.client` / `task.developer` compared with the signer; state and time checked in every instruction. |

### 3.3 Escrow token account

| Attribute | Value |
|---|---|
| Purpose | Holds the task's USDC. |
| Seeds | `["escrow", task_pda]` |
| Bump | Stored in the Task as `escrow_bump`. |
| Owner | SPL Token program |
| Mint | `platform.usdc_mint` |
| Authority | The Task PDA. No wallet key can sign for it. |
| Payer | Client, in `create_and_fund_task`. |
| Initialization | `create_and_fund_task`, in the instruction that funds it. |
| Close | Closed by the terminal transition; rent lamports return to the client. |
| Constraints | Seeds + bump; `token::mint = platform.usdc_mint`; `token::authority = task`. |
| Invoked by | Program CPI only, signed with the Task PDA seeds. |

Anyone can send tokens to a token account. So that a stray deposit cannot block
the close, every terminal transition transfers the **entire** balance: the fee is
always computed on `task.amount`, and the principal recipient (developer on
settlement, client on refund) receives everything that remains.

### 3.4 Treasury token account

| Attribute | Value |
|---|---|
| Purpose | Receives platform fees. |
| Seeds | None. An ordinary USDC token account whose address is stored in `platform.treasury`. |
| Owner | SPL Token program; the token-account owner is the treasury wallet. |
| Mint | `platform.usdc_mint` |
| Authority | Treasury wallet. The program never signs for it. |
| Initialization | Created outside the program before `initialize_platform`. |
| Constraints | `address = platform.treasury`; `token::mint = platform.usdc_mint`. |
| Invoked by | Passed to every developer-paying settlement. Not required by refunds. |

### 3.5 Client and developer token accounts

| Attribute | Value |
|---|---|
| Purpose | Funding source (client) and payout / refund destinations. |
| Seeds | None in the Taskra program. Destinations are the wallet's associated token account (ATA) for `platform.usdc_mint`. |
| Owner | SPL Token program |
| Initialization | Not created by the Taskra program. The SDK prepends an idempotent create-ATA instruction when a destination is missing, so the program needs no `init_if_needed`. |
| Constraints | Refund destination: `associated_token::mint = usdc_mint`, `associated_token::authority = task.client`. Payout destination: same with `task.developer`. Funding source in `create_and_fund_task`: `token::mint = usdc_mint`, `token::authority = client`. |

### 3.6 Keys

| Key | May do | May never do |
|---|---|---|
| Platform authority | `rotate_keys`; `resolve_dispute` on `DISPUTED` tasks before the dispute deadline | Touch a task that is not `DISPUTED`; send funds anywhere except the task's client or developer ATA; change fee or windows |
| Attester | `record_attestation` | Sign any fund-moving instruction; change config; resolve disputes |
| Treasury wallet | Withdraw collected fees from its own token account | Sign any Taskra instruction |
| Program upgrade authority | `initialize_platform` once; upgrade the program | Act as platform authority (must be a different key) |

### 3.7 Instruction set

| Instruction | Signer |
|---|---|
| `initialize_platform` | Program upgrade authority |
| `rotate_keys` | Platform authority |
| `create_and_fund_task` | Client |
| `cancel_task` | Client |
| `accept_task` | Developer |
| `submit_work` | Developer |
| `record_attestation` | Attester |
| `approve_task` | Client |
| `reject_task` | Client |
| `open_developer_dispute` | Developer |
| `expire_review` | Anyone |
| `refund_expired` | Client |
| `resolve_dispute` | Platform authority |
| `expire_dispute` | Anyone |

No separate attestation account and no WorkRecord account exist. The attestation
is three fields on the Task.

---

## 4. Atomic create + fund

`create_and_fund_task(task_id, amount, work_duration, terms_hash)` is a single
instruction:

1. Anchor validates the accounts: `client` is a signer; `platform` matches its
   seeds; `usdc_mint` has the address stored in `platform.usdc_mint`; the source
   token account has that mint and is owned by `client`.
2. The Task PDA is created with `init` (payer: client). If it already exists the
   instruction fails, so a `task_id` cannot be replayed.
3. The escrow token account PDA is created with `init` (payer: client), mint
   `usdc_mint`, authority the Task PDA.
4. `transfer_checked` moves `amount` from the source to escrow, authorised by the
   client's signature, with the mint's decimals.
5. The escrow balance is reloaded and required to equal `amount`.
6. Task fields are written, `fee_bps` is copied from the Platform, and state is
   set to `OPEN`.

Any failure reverts the whole transaction, including account creation and rent. A
partially funded task cannot exist.

Database side: the draft row already holds `task_id` and the client wallet, so the
API derives the Task PDA and reads it. On-chain values are authoritative.

---

## 5. Identifiers and hashes

### 5.1 Task ID

A 16-byte UUID (version 4), generated by the API when the draft is created.

| Aspect | Definition |
|---|---|
| Database | PostgreSQL `uuid`, primary key of the task. |
| On-chain | `[u8; 16]`: the UUID's bytes in network (big-endian) order, i.e. the hex digits of the canonical string read left to right. |
| PDA seeds | `["task", client_pubkey (32 bytes), task_id (16 bytes)]` |

`client_pubkey` is in the seeds so that nobody who learns a draft's UUID can
create the PDA first and block the real client.

### 5.2 Hash encoding

Both off-chain hashes (terms and evidence) use one encoding:

```text
hash = SHA-256( PREFIX || LP(field_1) || LP(field_2) || ... || LP(field_n) )
LP(x) = the byte length of x as a 4-byte big-endian unsigned integer, followed by x
```

- `PREFIX` is the ASCII domain-separation tag, with no terminator and no length
  prefix.
- Every field is a UTF-8 string. Numbers are written in decimal ASCII with no
  sign, no leading zeros and no separators (`0` is `0`).
- Fields appear in the fixed order given for each hash. There are no optional
  fields.
- The length prefixes make field boundaries unambiguous; the domain prefix makes
  an evidence hash and a terms hash different even for identical fields.
- The digest is 32 raw bytes on-chain and 64 lower-case hex characters in the
  database.

A reference encoder and the vectors below are executed by
`programs/taskra/tests/evidence.rs`.

### 5.3 Terms hash (D11)

`PREFIX = "taskra:terms:v1"`. Fields, in order:

| # | Field | Value |
|---|---|---|
| 1 | `repo` | `owner/name`, ASCII lower-cased, no scheme, host or `.git`. |
| 2 | `acceptance_criteria` | The text, Unicode NFC-normalized and then trimmed. |
| 3 | `work_duration` | Integer seconds, decimal. |
| 4 | `amount` | Token base units, decimal string. |

"Trimmed" means leading and trailing code points removed exactly as ECMAScript
`String.prototype.trim` removes them: U+0009–U+000D, U+0020, U+00A0, U+1680,
U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Normalize
first, then trim. Interior whitespace and line breaks are not altered, so the
normalized text is what must be stored and displayed.

The program stores the 32 bytes and requires them to be non-zero; it cannot
recompute them. The API and the frontend recompute the hash from the stored
metadata and refuse to treat metadata as authoritative when it does not match.

Test vectors:

| # | `repo` | `acceptance_criteria` | `work_duration` | `amount` | `terms_hash` |
|---|---|---|---|---|---|
| T1 | `octo-org/parser` | `Parses transaction signatures` + U+000A + `Returns structured output` | `172800` | `100000000` | `30847829aaee28ae7add3254b2f0bf44a262467ed115d4f87d041bd53f50c066` |
| T2 | `a/b` | raw: two spaces, `Cafe`, U+0301, ` tests pass `, U+000A | `1` | `1` | `f3bfcae9cdec77ec36a7223c7c8da9ce001e7d95a9ad72cbb10cd23d0130934c` |

In T2 the raw text normalizes to `Café tests pass` (with U+00E9; 16 UTF-8
bytes). Hashing that normalized text directly gives the same digest.

---

## 6. Money rules

- All amounts are `u64` token base units (USDC has 6 decimals: 100 USDC =
  `100_000_000`). TypeScript uses `bigint`. No floating point anywhere.
- `fee = floor(amount * fee_bps / 10000)`, computed with a `u128` intermediate
  and checked arithmetic; any overflow aborts the transaction.
- The developer receives `amount - fee` (plus any stray balance, §3.3).
- Example: amount `100_000_000`, `fee_bps = 250` → fee `2_500_000` (2.50 USDC),
  developer `97_500_000` (97.50 USDC).
- Below 40 base units the fee floors to zero and the developer receives the full
  amount.
- Refunds and cancellations carry no fee.

---

## 7. Verification: Option B (D2)

### 7.1 Off-chain verification

Performed by the API against the GitHub REST API and stored in PostgreSQL.

| Element | Definition |
|---|---|
| GitHub evidence | Repository (`owner/name`, bound to the task at creation), PR number, PR author, `merged_by`, head commit SHA, merge timestamp, repository `created_at`. |
| Verification status | `PENDING`, `VERIFIED` or `REJECTED`, with one auditable reason per failed rule (§10). |
| Evidence hash | The hash defined in §10.3, recomputed by the verifier from GitHub's data; it must equal the value the developer recorded on-chain. |
| Verification timestamp | UTC time the check ran. Results are append-only. |
| Verifier identity | The API deployment and rule-set version that produced the result, the GitHub response metadata, the attester public key and the attestation transaction signature. |
| Failure / PENDING | A GitHub API error, rate limit or timeout produces `PENDING` and is retryable. It never produces `VERIFIED`. |

### 7.2 On-chain authorization

| Question | Answer |
|---|---|
| What can the program verify independently? | Signers; account ownership; PDA derivation; token mint and token-account owners; task state; the on-chain clock against stored deadlines; that a supplied hash and nonce equal the stored ones; arithmetic. |
| What can it not verify? | Any GitHub fact, or what the 32 bytes of `evidence_hash` are a hash of. |
| What is trusted from the backend? | One bit per submission: "this hash at this nonce is VERIFIED", signed by the attester key. |
| Trust boundary | The program trusts signatures and its own state, never request bodies or database rows. |

### 7.3 The attestation

`record_attestation(evidence_hash, submission_nonce)`:

- Signer must equal `platform.attester`.
- The task must be `SUBMITTED`, and both arguments must equal the task's current
  `evidence_hash` and `submission_nonce`.
- `now ≤ verification_deadline`.
- Effect: `attested_hash`, `attested_nonce`, `verified_at` are written;
  `review_deadline = now + review_window`; state becomes `UNDER_REVIEW`.
- The instruction's account list contains the attester, the Platform and the
  Task. It contains no token account, so it cannot move funds.

Binding: the attestation is bound to the task (it is written into that Task
account), to the evidence hash and to the nonce. Every `submit_work` increments
the nonce and clears the attestation, so an attestation signed for an earlier
submission is rejected even if the same hash is submitted again.

### 7.4 Attester key

| Property | Definition |
|---|---|
| Permission | Exactly one instruction, `record_attestation`. Never a signer on any fund-moving instruction. |
| Storage | A dedicated keypair held as a `SECRET` (`ATTESTER_SECRET_KEY`) in the attestation service's own secret store, separate from the API's (`14-API-CONTRACT.md` §6). Never in the repository, the database, logs, the API process or the frontend. Holds only enough SOL for fees. Devnet/test only during development. |
| Separation | Distinct from the platform authority and the treasury wallet; enforced on-chain. |
| Rotation | Only the platform authority, through `rotate_keys`. The old key stops working immediately. Attestations already recorded stay valid. |

No attester key exists in the repository. The attestation service is
`apps/attester`; its security model is in `06-GITHUB-VERIFICATION-SPEC.md`
("Attestation service security").

### 7.5 Threat model

| Threat | Result |
|---|---|
| Developer submits a junk hash; client absent | No attestation, no payment. Developer may escalate (T12); with no attestation the fallback refunds the client. |
| Automated junk submissions | Cannot reach payment without the attester or the authority. |
| Client absent, work verified | Attested; developer paid on review expiry. |
| Client rejects verified work | `DISPUTED`; authority decides; if it does not, the fallback pays the developer because a valid attestation exists. |
| Client never merges the PR | Verification cannot succeed. Developer escalates (T12); authority decides on the merits; if it does not, the client is refunded. |
| **Attester key stolen** | The attacker can mark any `SUBMITTED` task VERIFIED. This cannot withdraw funds: it only starts the review window. The client can still reject. The attacker cannot move funds, change destinations, change config or resolve disputes. |
| **Residual assumption: attester + colluding developer + absent client** | A junk submission is attested, the client does not reject within the review window, and `expire_review` pays the developer. Likewise, if the client rejects but the authority is also absent for the dispute timeout, the fallback pays the developer. Clients must respond within the review window, and the authority within the dispute timeout, for this collusion to fail. This is the accepted residual risk of Option B. |
| Attester down or censoring | Genuine work is not attested. A cooperative client approves directly. Otherwise the developer escalates (T12) and the authority decides. |
| Stale attestation after resubmission | Rejected: the nonce no longer matches. |
| Backend or database compromise without the attester key | No on-chain effect. Terms shown to users are checked against `terms_hash`. |
| Platform authority compromised | Can resolve `DISPUTED` tasks either way (only to the task's client or developer), and rotate the attester and treasury. Cannot touch tasks that are not `DISPUTED`; cannot change fee or windows; cannot send escrow to a third party. A treasury rotated to an unusable account blocks developer-paying settlements until rotated back; refunds are unaffected. |
| Platform authority unavailable | Disputes resolve through the permissionless fallback after 7 days. |
| Program upgrade authority compromised | Can replace the program and take all escrow. Residual risk of any upgradeable program; this key is kept separate from the platform authority and off any server. |
| `initialize_platform` front-run | Prevented: the signer must be the upgrade authority. |
| Fake mint or fake token account | Prevented: the mint is pinned in Platform; every token account is constrained by mint and owner. |
| Stray deposit into escrow | Swept to the principal recipient (§3.3). |
| Accept-squatting (D9) | A wallet accepts tasks and never submits, locking each until its work deadline. No funds are lost. **Known MVP limitation; no mitigation.** A junk submission can extend the delay to `refund_open_at`, or to the dispute deadline if the squatter also escalates. |
| Validator clock drift | Deadlines shift by seconds; windows are hours or days. |
| USDC issuer freezes an account | Outside Taskra's control. |

---

## 8. Dispute resolution (D5, D6)

- `reject_task` (client, during review) and `open_developer_dispute` (developer,
  §2.4) are the only ways into `DISPUTED`.
- `resolve_dispute(outcome)` is signed by the platform authority while
  `now ≤ dispute_deadline`. `outcome` is `PayDeveloper` or `RefundClient`.
- `expire_dispute` is permissionless once `now > dispute_deadline`. It pays the
  developer if and only if a valid attestation exists for the current evidence
  hash and nonce; otherwise it refunds the client. The branch is decided by
  on-chain state alone.

---

## 9. Valid submission (D7)

On-chain, a submission is a successful `submit_work` by the recorded developer at
or before the work deadline with a non-zero evidence hash. A submission is
**valid** when it has a VERIFIED attestation, which the attester issues only for
evidence that passes every rule in §10.1.

---

## 10. Evidence verification rules

Implemented off-chain in Phase 4.

### 10.1 Rules

| # | Rule | On failure |
|---|---|---|
| R1 | The URL is a GitHub pull request. | REJECTED |
| R2 | The PR targets exactly the repository named in the task. | REJECTED |
| R3 | The repository exists and its `created_at` is earlier than the task's creation timestamp ("pre-existing history"). | REJECTED |
| R4 | The pull request exists and is merged. | REJECTED |
| R5 | The PR author is the GitHub identity connected to the developer's wallet. | REJECTED |
| R6 | `merged_by` differs from the PR author. Self-merge is REJECTED. | REJECTED |
| R7 | The merge timestamp is after task acceptance. | REJECTED |
| R8 | The merge timestamp is at or before the work deadline. | REJECTED |
| R9 | The evidence hash recomputed from GitHub's data (the task's repository, the PR number, and the merged PR's final head SHA) equals the `evidence_hash` on the Task account. | REJECTED |
| R10 | Any GitHub API failure, rate limit or timeout. | PENDING, retryable; never VERIFIED |

The verifier never trusts a hash, head SHA or repository name supplied in a
request: it fetches the PR from GitHub, recomputes the hash itself and compares
it with the on-chain value (R9).

CI or test status is **informational only**. Taskra verifies evidence against
these conditions; it does not claim a merged PR proves the work is correct.

### 10.2 Statuses

`PENDING`, `VERIFIED` (all of R1–R9 hold), `REJECTED` (at least one of R1–R9
fails on real data). Every result stores which rules passed and failed.

### 10.3 Evidence hash (D21)

Encoding per §5.2 with `PREFIX = "taskra:evidence:v1"`. Fields, in order:

| # | Field | Value |
|---|---|---|
| 1 | `repo` | `owner/name`, ASCII lower-cased, no scheme, host or `.git`. |
| 2 | `pr_number` | The pull request number, decimal. |
| 3 | `head_sha` | The PR's head commit SHA: 40 lower-case hexadecimal characters. |

`head_sha` replaces `merge_commit_sha`. A head SHA exists for every pull request,
merged or not, so a developer can always compute and submit a hash.

Test vectors:

| # | `repo` | `pr_number` | `head_sha` | `evidence_hash` |
|---|---|---|---|---|
| E1 | `octo-org/parser` | `42` | `0123456789abcdef0123456789abcdef01234567` | `926d8ba0f3545c78cdd042d93f7269e67a984224d834bce7a2f379a1303ceef1` |
| E2 | `a/b` | `1` | `ffffffffffffffffffffffffffffffffffffffff` | `284d3265700774db64c4afa8da7fb252ca9979bbcab298cf379aed52b01791cf` |
| E3 | `octo-org/parser` | `42` | `0123456789abcdef0123456789abcdef01234568` | `96c47c4da14961d66d9bfd7844bce5ed80a4bfa7781a0fd29c149f5011749190` |

E3 is E1 with one more commit on the PR: a different head SHA gives an unrelated
hash. The full preimage of E2, in hex, is:

```text
7461736b72613a65766964656e63653a7631              "taskra:evidence:v1"
00000003 612f62                                   LP("a/b")
00000001 31                                       LP("1")
00000028 66666666666666666666666666666666666666666666666666666666666666666666666666666666
                                                  LP("ffff...ffff", 40 bytes)
```

### 10.4 Evidence lifecycle

1. **Submission is generic.** `submit_work` accepts any non-zero 32 bytes. The
   program cannot check what they are a hash of, and does not need to: the hash
   authorizes nothing by itself. Money leaves escrow for the developer only
   through `approve_task` (the client's signature), `resolve_dispute` (the
   authority's signature), or an attestation, and an attestation is bound to the
   task, to this exact hash and to this submission nonce (§7.3).
2. **Verification.** The verifier loads the PR from GitHub, checks R1–R8,
   recomputes the hash from GitHub's own data (R9) and attests only if it equals
   the hash on the Task account. A hash of anything else, including a made-up
   value, can never match, so it can never be attested.
3. **Merged PR.** The final head SHA is fixed at merge. If the developer
   submitted the hash for that head, verification succeeds, the attestation is
   recorded and the review window starts.
4. **Unmerged PR.** R4 fails, so there is no attestation and the task stays
   `SUBMITTED`. The developer-dispute path applies (§2.4): the developer may
   escalate, and the authority decides on the merits; otherwise the client is
   refunded.
5. **Later commits.** Any new commit changes `head_sha`, so the previously
   submitted hash no longer matches GitHub and R9 fails. The developer must
   resubmit the new hash, which starts a new submission nonce and voids any
   earlier attestation. Resubmission is possible until the work deadline.
6. **Arbitrary hash.** A developer-chosen arbitrary hash can produce delay and
   nothing else: it is never attested, so it follows the junk path analysed in
   §2.7 and ends in a client refund unless the client or the authority chooses to
   pay.

---

## 11. Transaction confirmation policy

| Commitment | Used for | Meaning in Taskra |
|---|---|---|
| `confirmed` | UI transaction progress | The UI may show "confirmed" and advance. The database may record the transaction as observed. |
| `finalized` | Authoritative financial records | Only at `finalized` does the backend write a settlement, refund or reputation change as authoritative. |

Until a settlement transaction is finalized the database holds it as a pending
observation and no reputation aggregate includes it.

---

## 12. Toolchain and version matrix

| Tool | Pinned version | Why | Installed in WSL |
|---|---|---|---|
| Rust | 1.89.0 | MSRV of `anchor-lang` 1.1.2 and the channel `anchor init` 1.1.2 pins. | Yes |
| Solana CLI (Agave) | 3.1.10 | Pinned by Anchor's CI at tag `v1.1.2`; recommended by the Anchor 1.0.0 release notes. | Yes |
| Anchor CLI | 1.1.2 | Matches the installed Solana CLI. | Yes |
| AVM | 1.1.2 | Ships with the Anchor release. | Yes |
| Node.js | 24.18.1 | Satisfies Next.js 16.3.8, Vitest 5.0.3 and ESLint 10.11.0. | Yes |
| pnpm | 12.3.4 | `packageManager` field. | Yes |
| PostgreSQL | 17.11 (`postgres:17.11-alpine3.24`) | Pinned image tag. | via Docker |

Anchor 1.2.0 (Solana CLI 4.1.2) exists and is deliberately not used.

The repository lives at `~/taskra` in the WSL filesystem. The program-address
keypair `target/deploy/taskra-keypair.json` is git-ignored, was generated inside
WSL, controls no funds and no authority, and only fixes the address in
`declare_id!`.

---

## 13. Engineering choices

Reversible implementation details, recorded for transparency.

| Point | Choice |
|---|---|
| Resubmission after attestation | Allowed until the work deadline; it voids the attestation (§2.5). |
| Authority resolution window | `resolve_dispute` is valid only until the dispute deadline, so it is disjoint from the fallback. |
| `approve_task` during review | Valid only until the review deadline; afterwards `expire_review` produces the same outcome. |
| `refund_expired` signer | The client. It is the client's money and only a refund is possible in those states. |
| Platform windows and fee | Immutable after initialization; only keys rotate. |
| Optional accounts | `resolve_dispute` and `expire_dispute` take the developer and treasury accounts only on the pay-developer branch, so a missing or unusable treasury can never block a refund. |
| Program test runner | LiteSVM through `cargo test`, the Anchor 1.x default; its clock control makes deadline tests deterministic. |
| `GITHUB_WEBHOOK_SECRET` | Removed; the MVP uses no webhooks. |
| Migration tool | `node-pg-migrate` with plain SQL. |
| API framework | Fastify. |
| Worker process | No keeper. Expiry instructions are permissionless and the API reconciles chain state on request. The one background process is the attestation service below. |
| Attestation service | A separate process, `apps/attester`, containing both the GitHub verifier and the attester signer, with no network listener. The API hands it work only by inserting a row into a database queue; the service re-derives every fact before signing. This is the "separate attestation service" required by `14-API-CONTRACT.md` §6. |
| Database access | `pg` with parameterized SQL and `node-pg-migrate`; no ORM. A later instruction to use Prisma was not followed because this row and the Phase 0 tooling already fixed the choice; changing it is possible but buys nothing for this schema. |
| Database isolation | Two roles, `taskra_api` and `taskra_attester`, with table privileges (`04-DATABASE-SPEC.md` §6). No row-level security: the system is single-tenant. |
| Sessions | Opaque random token in an `HttpOnly; SameSite=Strict` cookie; only its SHA-256 is stored; 24 h absolute lifetime; no renewal. CSRF is additionally blocked by an `Origin` check on every non-GET request. The web app and the API must share a site. |
| API versioning | Endpoints live under `/api/v1`; the shapes are those of `05-API-SPEC.md`. |
| Transactions without a dedicated endpoint | Cancel, refund, dispute and expiry transactions are reported to `POST /api/v1/tasks/:id/transactions`, which accepts any Taskra instruction for that task. |
| Rejection reason hash | Plain SHA-256 of the reason text after NFC normalization and trimming (`rejectionReasonHash` in the SDK), as §2.5 T10 specifies. |
| Reputation storage | SQL views over finalized `settlements` rather than snapshot rows, so an aggregate cannot drift from its source. |
| Reliable Contributor | 3 settled tasks from 3 distinct clients, computed off-chain. The product specification's "minimum task value" has no number, so it is not applied. |
| Reliability Score | Not reduced to one number: the specification gives the terms of the formula but no weights. The API and UI show the components (settled, distinct clients, disputed, refunded). |
| CI status | Not fetched or displayed. It was optional and informational; omitting it avoids implying it matters. |
| Test database | An ephemeral PostgreSQL 17.10 from `embedded-postgres` (test-only dependency), or the server named by `TASKRA_TEST_DATABASE_URL`. docker-compose remains the development database. |

---

## 14. Known limitations

| # | Limitation |
|---|---|
| L1 | Accept-squatting (D9). |
| L2 | The residual collusion assumption of Option B (§7.5). |
| L3 | The program is upgradeable; the upgrade authority is fully trusted. |
| L4 | A junk submission can delay the client's refund by up to `work_duration + max(review_window, verification_grace) + review_window + dispute_timeout` after acceptance (production: `work_duration + 11 days`) when the authority is absent (§2.7). It can never produce a payment. |
| L5 | A treasury token account that is closed or frozen blocks developer-paying settlements until the authority rotates it. |
| L6 | An unmerged PR can never be VERIFIED. A developer whose work the client will not merge depends on the authority's decision in a dispute; if the authority is absent the client is refunded. |

---

## 15. Deploy profiles (D23)

The fee and the three time windows are arguments of `initialize_platform`. They
are written once and **cannot be changed afterwards**; only keys rotate. Each
cluster has its own Platform account, so each deployment picks one profile.

| Parameter | Production | Devnet demo |
|---|---|---|
| `fee_bps` | 250 | 250 |
| `review_window` | 172 800 s (48 h) | 600 s (10 min) |
| `verification_grace` | 86 400 s (24 h) | 300 s (5 min) |
| `dispute_timeout` | 604 800 s (7 d) | 900 s (15 min) |
| Maximum client-fund lock (§2.7) | `work_duration + 11 d` | `work_duration + 35 min` |

- The devnet-demo profile exists so that review expiry, developer dispute and the
  dispute fallback can be shown in real time. It must never be used where real
  funds are at stake: ten minutes is not a meaningful review period.
- Because the windows are immutable, choosing them is a deployment decision, not
  a runtime one. Changing them later means deploying a new program instance.
- Shortening `dispute_timeout` at deploy time reduces the maximum client-fund
  lock by the same amount. Shortening `review_window` reduces it by twice that
  amount while it remains at least `verification_grace`, because the review
  window also sets the length of the developer's dispute window.
- The program validates only that each window is positive and that
  `fee_bps ≤ 10000`. It does not know which cluster it runs on; picking the right
  profile is the deployer's responsibility.

`client_lock.rs` runs the worst-case timeline under both profiles.

---

## 16. Test evidence

| Suite | What it establishes |
|---|---|
| `lifecycle.rs` | Each transition of §2.3 with exact fund movements; the fee is charged on the principal only; stray deposits follow the principal. |
| `authorization.rs` | Signer, mint, token-account and destination checks; key separation; stale attestations. |
| `exclusivity.rs` | Double settlement on every settlement path, races, deadline boundaries, and the mutual-exclusion cases of §2.6. |
| `client_lock.rs` | The worst-case client-fund lock equals the formula in §2.7 for three window profiles. |
| `evidence.rs` | The hash test vectors of §5.3 and §10.3; an attestation for one hash cannot settle another; an arbitrary hash never pays by itself. |
| `randomized.rs` | Random instructions, signers and clock advances; after every step escrow equals the amount or the task is terminal with escrow closed, payouts never exceed the amount, and at most one terminal outcome occurs. |
| `scripts/mutation-check.sh` | Eight seeded defects, each of which the suite must catch. |
| `sdk_vectors.rs` | PDA addresses and error codes equal the literals the TypeScript SDK asserts. |
| `packages/sdk` unit tests | Every PDA, all 14 instruction builders, decoders, enum and error parity with the IDL, fee and hash vectors, timeline vectors, and that no shipped SDK source imports a key or signing API. |
| `scripts/validator-loop.sh` | The SDK against a real `solana-test-validator` and a real SPL mint: approval, review expiry, cancellation and both dispute-fallback branches. It uses a test-only profile (review 10 s, grace 5 s, dispute timeout 8 s), which is not a deploy profile. |

The randomized suite always runs the fixed seed `0x7A5C2026` and the range
`0..TASKRA_FUZZ_SEEDS` (default 48), each for `TASKRA_FUZZ_STEPS` steps (default
60). Both are environment variables so CI can run a longer campaign.
