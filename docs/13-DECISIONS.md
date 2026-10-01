# Taskra — Decisions, Canonical State Machine and Account Model

This document is the single authoritative definition of the task lifecycle, the
on-chain account model and the engineering decisions taken after the Phase-0
assessment. Where it conflicts with any other document in `docs/`, this document
wins; the other documents have been amended to match.

Every item is marked with its status:

- **APPROVED** — decided by the project owner. Binding.
- **PROPOSED** — engineering proposal. Not binding and not to be implemented
  until explicitly approved.

Nothing in this document is implemented yet. Phase 0 contains no product logic.

---

## 1. Decision log

| # | Topic | Decision | Status |
|---|---|---|---|
| D1 | Fee | 2.5%, stored as `fee_bps = 250` in Platform config. `fee = floor(amount * fee_bps / 10000)`; developer receives `amount - fee`; fee goes to the configured treasury token account. Checked integer arithmetic in token base units only. | APPROVED |
| D2 | Verification gate | Not implemented yet. Options A and B are analysed in §7; a recommendation is made there and awaits approval. No attester key exists. | PENDING APPROVAL |
| D3 | Dispute | Rejection moves directly to `DISPUTED` (no separate `open_dispute`). Platform authority has exactly two outcomes: full refund to client, or full payment to developer (fee applies). No split. Destinations are restricted to the task's recorded client and developer. A permissionless timeout fallback exists; its outcome is proposed in §8. | APPROVED (fallback outcome PROPOSED) |
| D4 | Exit paths | Client may cancel before acceptance (full refund). Client may take a full refund when the work deadline passes without a valid submission. "Valid submission" is defined in §9. | APPROVED (definition PROPOSED) |
| D5 | Reliability rewards | Deferred from the MVP. No on-chain reward payout, reserve account, distribution instruction or reward escrow. The "Reliable Contributor" milestone is computed off-chain and labelled **Off-chain aggregate**. | APPROVED |
| D6 | Review window | One global Platform value, default 48 hours, set in `initialize_platform`, stored in Platform state, never hardcoded in instruction logic. | APPROVED |
| D7 | Confirmation policy | `confirmed` for UI progress; `finalized` before the backend records a financial settlement as authoritative. See §11. | APPROVED |
| D8 | Toolchain | Ubuntu on WSL; repository lives at `~/taskra` (never under `/mnt/c`). Versions are pinned in §13. No system installation without approval of the exact commands. | APPROVED |
| D9 | Credentials | Phase 0 does not depend on external credentials. `.env.example` labels every variable. The devnet USDC mint comes from Circle's official documentation and is never invented or hardcoded. | APPROVED |
| D10 | Product defaults | Next.js web; separate Node.js/TypeScript API; pnpm monorepo; one wallet identity per user; any wallet other than the task client may accept; GitHub pull requests are the only MVP evidence type; the client names the target repository at task creation. | APPROVED |
| D11.1 | Create + fund | One atomic on-chain operation. Unfunded tasks do not exist on-chain; drafts exist only in the database. See §4. | APPROVED |
| D11.2 | Task ID | 16-byte UUID. See §5. | PROPOSED |
| D11.3 | Authority separation | Platform authority, treasury and any future attester are separate keys. Only the platform authority rotates those references. See §12. | APPROVED |
| D11.4 | AGENTS.md rule 5 | Amended as instructed. | APPROVED |
| D12 | Evidence rules | Self-merge is REJECTED; repository `created_at` must precede task creation; evidence hash is SHA-256 of canonical JSON; PR must target the task's repository; test status is informational; GitHub API failures become PENDING. See §10. | APPROVED |

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
| `SUBMITTED` | On-chain | The developer has recorded an evidence hash. | No |
| `UNDER_REVIEW` | On-chain | The evidence hash has a VERIFIED attestation; the client review window is running. **Exists only under Option B (§7).** | No |
| `DISPUTED` | On-chain | The client rejected within the review window; awaiting platform resolution or the timeout fallback. | No |
| `SETTLED` | On-chain | Escrow paid to the developer (minus fee). | Yes |
| `REFUNDED` | On-chain | Escrow returned in full to the client after acceptance. | Yes |
| `CANCELLED` | On-chain | Client cancelled before acceptance; escrow returned in full. | Yes |

How the previously conflicting names map:

| Old name | Canonical |
|---|---|
| `CREATE`, `DRAFT` | `DRAFT` (database only) |
| `FUNDED` | Removed. Creation and funding are atomic, so a funded task is `OPEN`. |
| `SUBMITTED` vs `UNDER REVIEW` | Two distinct states under Option B (before / after attestation). Under Option A `UNDER_REVIEW` is removed and `SUBMITTED` is the review state. |
| `APPROVED`, `REVIEW EXPIRES`, `REJECTED` | Transitions, not states. Approval and payment happen in one instruction. |

### 2.2 Transition table

The table is written for **Option B**, the recommended option (§7). Rows that
change under Option A are listed in §2.4. Times are the on-chain clock
(`Clock::unix_timestamp`, UTC seconds).

| # | State | Actor | Action | Preconditions | Next State | Fund Movement |
|---|---|---|---|---|---|---|
| T0 | — | Client | API: create draft | Authenticated wallet session | `DRAFT` | None |
| T1 | `DRAFT` | Client | `create_task` (atomic create + fund) | `amount > 0`; `work_duration > 0`; Task PDA does not exist; client token account holds `amount` of the configured mint | `OPEN` | Client → escrow: `amount` |
| T2 | `OPEN` | Client | `cancel_task` | Signer is `task.client` | `CANCELLED` | Escrow → client: full balance |
| T3 | `OPEN` | Developer | `accept_task` | Signer ≠ `task.client` | `ACCEPTED` | None |
| T4 | `ACCEPTED` | Developer | `submit_work` | Signer is `task.developer`; `now ≤ work_deadline`; evidence hash is non-zero | `SUBMITTED` | None |
| T5 | `SUBMITTED` | Developer | `submit_work` (resubmission) | Same as T4; replaces the evidence hash | `SUBMITTED` | None |
| T6 | `SUBMITTED` | Attester | `attest_verification` | Signer is `platform.attester`; supplied hash equals `task.evidence_hash`; `now ≤ verification_deadline` | `UNDER_REVIEW` | None |
| T7 | `ACCEPTED` | Client | `refund_task` (missed work deadline) | Signer is `task.client`; `now > work_deadline` | `REFUNDED` | Escrow → client: full balance |
| T8 | `SUBMITTED` | Client | `refund_task` (never verified) | Signer is `task.client`; `now > verification_deadline` | `REFUNDED` | Escrow → client: full balance |
| T9 | `SUBMITTED` or `UNDER_REVIEW` | Client | `approve_task` | Signer is `task.client`; supplied hash equals `task.evidence_hash` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T10 | `UNDER_REVIEW` | Client | `reject_task` | Signer is `task.client`; `now ≤ review_deadline`; reason hash is non-zero | `DISPUTED` | None |
| T11 | `UNDER_REVIEW` | Anyone | `expire_review` | `now > review_deadline` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T12 | `DISPUTED` | Platform authority | `resolve_dispute(PayDeveloper)` | Signer is `platform.authority` | `SETTLED` | Escrow → treasury: `fee`; escrow → developer: remainder |
| T13 | `DISPUTED` | Platform authority | `resolve_dispute(RefundClient)` | Signer is `platform.authority` | `REFUNDED` | Escrow → client: full balance |
| T14 | `DISPUTED` | Anyone | `expire_dispute` | `now > disputed_at + dispute_timeout` | See §8 (PROPOSED) | See §8 |

Derived timestamps:

- `work_deadline = accepted_at + work_duration` (PROPOSED; see U1 in §16)
- `verification_deadline = work_deadline + verification_grace` (Option B only)
- `review_deadline = verified_at + review_window` (Option B) or
  `submitted_at + review_window` (Option A)

Boundary convention: the party bound by a deadline may act while `now ≤ deadline`;
the counter-party's remedy opens when `now > deadline`. The two are never valid at
the same timestamp.

### 2.3 Per-transition detail

Common to every fund-moving transition (T2, T7, T8, T9, T11, T12, T13, T14):

- The instruction requires one specific non-terminal source state, writes a
  terminal state, transfers the **entire** escrow balance and closes the escrow
  token account, all in one transaction. A second call fails twice over: the
  state constraint no longer holds and the escrow account no longer exists. This
  is why no transition can settle twice.
- Solana transactions are atomic. If any transfer or check fails, the state
  change is reverted with it.
- Destinations are never free parameters. They are validated against
  `task.client`, `task.developer` or `platform.treasury`.

| # | Authorization | Destination account | Fee treatment | Terminal | Why it cannot double-settle |
|---|---|---|---|---|---|
| T0 | API session of the client wallet | — | — | No | No funds exist. |
| T1 | Client signs; pays rent for Task and escrow | Escrow token account (PDA) | None taken at funding | No | Task PDA is created with `init`; the same `(client, task_id)` cannot be created twice. |
| T2 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `OPEN`; sets `CANCELLED`; closes escrow. |
| T3 | Any signer ≠ client | — | — | No | No funds move. Records `developer` once; `OPEN` cannot recur. |
| T4 | `signer == task.developer` | — | — | No | No funds move. |
| T5 | `signer == task.developer` | — | — | No | No funds move. Not allowed once attested, so the reviewed evidence cannot be swapped. |
| T6 | `signer == platform.attester` | — | — | No | No funds move. The attester has no fund-moving instruction. |
| T7 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `ACCEPTED`; sets `REFUNDED`; closes escrow. |
| T8 | `signer == task.client` | Client USDC ATA | None | Yes | Requires `SUBMITTED`; sets `REFUNDED`; closes escrow. |
| T9 | `signer == task.client` | Treasury token account; developer USDC ATA | `fee` on `task.amount` at the snapshotted `task.fee_bps` | Yes | Requires `SUBMITTED`/`UNDER_REVIEW`; sets `SETTLED`; closes escrow. |
| T10 | `signer == task.client` | — | — | No | No funds move. |
| T11 | Permissionless | Treasury token account; developer USDC ATA | As T9 | Yes | Requires `UNDER_REVIEW`; sets `SETTLED`; closes escrow. |
| T12 | `signer == platform.authority` | Treasury token account; developer USDC ATA | As T9 | Yes | Requires `DISPUTED`; sets `SETTLED`; closes escrow. |
| T13 | `signer == platform.authority` | Client USDC ATA | None | Yes | Requires `DISPUTED`; sets `REFUNDED`; closes escrow. |
| T14 | Permissionless | Fixed by the approved fallback outcome | Per outcome | Yes | Requires `DISPUTED`; sets a terminal state; closes escrow. |

Notes:

- **T5 resubmission.** Allowed only while `SUBMITTED` and only until the work
  deadline. It exists so a developer can correct evidence that off-chain
  verification marked REJECTED or PENDING.
- **T9 hash argument.** The client passes the evidence hash they reviewed. If the
  developer resubmits between review and approval, the approval fails instead of
  silently approving different evidence.
- **T9 from `SUBMITTED`.** The client may always approve their own task without
  an attestation. It is the client's money and the client's judgement; this also
  means attester downtime can never block a willing client from paying.
- **T10 reason hash.** The product specification requires a rejection to carry a
  reason. The reason text is stored off-chain; its SHA-256 is recorded on-chain so
  it cannot be changed afterwards.

### 2.4 Option A delta

If Option A (no attester) is approved instead, the table changes as follows:

- `UNDER_REVIEW`, T6 and T8 are removed. `verification_grace` and
  `platform.attester` do not exist.
- `SUBMITTED` is the review state. `review_deadline = submitted_at + review_window`.
- T5 resubmission restarts the review window from the resubmission time.
- T9, T10 and T11 apply from `SUBMITTED`.
- T7 remains the only missed-deadline refund.

---

## 3. Account and PDA model (PROPOSED)

All accounts are owned by the Taskra program unless stated. The token program is
the classic SPL Token program (the program that owns the USDC mint); Token-2022 is
not accepted. Fields marked *(B)* exist only under Option B.

### 3.1 Platform

| Attribute | Value |
|---|---|
| Purpose | Singleton configuration: authorities, mint, fee, time windows. |
| Seeds | `["platform"]` |
| Bump | Canonical bump stored in the account; re-checked with `bump = platform.bump`. |
| Owner | Taskra program |
| Fields | `authority`, `treasury` (USDC token account address), `usdc_mint`, `fee_bps: u16`, `review_window: i64`, `dispute_timeout: i64`, `attester` *(B)*, `verification_grace: i64` *(B)*, `bump` |
| Authority | `platform.authority` |
| Payer | Signer of `initialize_platform` |
| Initialization | `initialize_platform`, once. The signer must be the program's upgrade authority, checked against the program's ProgramData account, so nobody can front-run initialization after deployment. Validates `fee_bps ≤ 10000`, positive windows, and that `treasury` is a token account of `usdc_mint`. |
| Mutability | Only through `update_platform`, signed by `platform.authority`. `usdc_mint` is immutable. |
| Close | Never. |
| Constraints | Seeds + bump; `usdc_mint` and `treasury` are checked by address wherever they are used. |
| Invoked by | Read by every instruction. Written by `initialize_platform` and `update_platform` only. |

### 3.2 Task

| Attribute | Value |
|---|---|
| Purpose | Economically relevant task state. After a terminal transition it is the permanent verified-work record. |
| Seeds | `["task", client_pubkey, task_id]` where `task_id` is 16 raw bytes (§5). |
| Bump | Stored in the account; re-checked on every use. |
| Owner | Taskra program |
| Fields | `task_id: [u8; 16]`, `client`, `developer`, `amount: u64`, `state`, snapshots of `fee_bps`, `review_window`, `dispute_timeout`, `verification_grace` *(B)* taken at creation, `work_duration: i64`, `created_at`, `accepted_at`, `work_deadline`, `submitted_at`, `evidence_hash: [u8; 32]`, `verified_at` *(B)*, `review_deadline`, `disputed_at`, `rejection_reason_hash: [u8; 32]`, `closed_at`, `outcome`, `bump`, `escrow_bump` |
| Authority | The Task PDA is itself the authority of its escrow token account. |
| Payer | Client, in `create_task`. |
| Initialization | `create_task` only (`init`; fails if the PDA already exists). |
| Mutability | Only through the transitions in §2.2. |
| Close | Never. Keeping it is what makes settlement history independently verifiable. |
| Constraints | Seeds + bump; `task.client` / `task.developer` compared with the signer per §2.3; state checked on every instruction. |
| Invoked by | Client, developer, attester *(B)*, platform authority, or anyone, each limited to the transitions in §2.2. |

Config values are **snapshotted** into the task at creation. A later
`update_platform` therefore cannot change the fee or the time windows of a task
that is already funded. The treasury address is read live so that a compromised
or closed treasury account can be rotated.

### 3.3 Escrow token account

| Attribute | Value |
|---|---|
| Purpose | Holds the task's USDC. |
| Seeds | `["escrow", task_pda]` |
| Bump | Stored in the Task as `escrow_bump`. |
| Owner | SPL Token program |
| Mint | `platform.usdc_mint` |
| Authority | The Task PDA (token-account owner). No wallet key can sign for it. |
| Payer | Client, in `create_task`. |
| Initialization | `create_task`, in the same instruction that funds it. |
| Mutability | Debited only by the fund-moving transitions in §2.2. |
| Close | Closed by the terminal transition; rent lamports return to the client, who paid them. |
| Constraints | Seeds + bump; `token::mint = platform.usdc_mint`; `token::authority = task`. |
| Invoked by | Program CPI only, signed with the Task PDA seeds. |

Anyone can send tokens to a token account. To prevent a stray deposit from
blocking the close, every terminal transition transfers the **entire** balance:
the fee is always computed on `task.amount`, and the principal recipient receives
everything that remains.

### 3.4 Treasury token account

| Attribute | Value |
|---|---|
| Purpose | Receives platform fees. |
| Seeds | None. An ordinary USDC token account whose address is stored in `platform.treasury`. |
| Owner | SPL Token program; token-account owner is the treasury wallet (separate from the platform authority). |
| Mint | `platform.usdc_mint` |
| Authority | Treasury wallet. The program never signs for it. |
| Payer / initialization | Created outside the program before `initialize_platform`. |
| Mutability | Credited by settlement. The stored address changes only through `update_platform`. |
| Close | Outside the program. If it is closed or frozen, settlements fail until the platform authority rotates it. |
| Constraints | `address = platform.treasury`; `token::mint = platform.usdc_mint`. |
| Invoked by | Passed to T9, T11, T12 and a developer-paying T14. |

### 3.5 Client and developer token accounts

| Attribute | Value |
|---|---|
| Purpose | Funding source (client) and payout / refund destinations. |
| Seeds | None in the Taskra program. Each is the wallet's associated token account (ATA) for `platform.usdc_mint`. |
| Owner | SPL Token program |
| Mint | `platform.usdc_mint` |
| Authority | The client or developer wallet. |
| Payer / initialization | Not created by the Taskra program. The SDK prepends an idempotent create-ATA instruction when a destination is missing, so the program needs no `init_if_needed`. |
| Constraints | Client: `associated_token::mint = usdc_mint`, `associated_token::authority = task.client`. Developer: same with `task.developer`. In `create_task` the source must be owned by the signing client. |
| Invoked by | Client account: T1, T2, T7, T8, T13. Developer account: T9, T11, T12. |

### 3.6 Authority accounts

| Key | Role | May do | May never do |
|---|---|---|---|
| Platform authority | Signer | `update_platform`; `resolve_dispute` on `DISPUTED` tasks | Touch escrow of a task that is not `DISPUTED`; send funds anywhere except the task's client or developer; change terms of existing tasks |
| Treasury wallet | Owner of the treasury token account | Withdraw collected fees | Sign any Taskra instruction |
| Attester *(B)* | Signer | `attest_verification` | Move funds; change config; resolve disputes |
| Program upgrade authority | Signer of `initialize_platform` and of program upgrades | Initialize once; upgrade the program | — (an upgrade can change anything; see residual risks in §7.5) |

### 3.7 WorkRecord — evaluated, not recommended

The on-chain specification asks for a `WorkRecord` account to be evaluated. The
recommendation is **not to create one**. The Task account is never closed and,
once terminal, already holds everything a work record would: client, developer,
amount, fee rate, evidence hash, timestamps and outcome. A separate account would
duplicate that data and would need a rent payer on the permissionless expiry
paths. Records for a developer are found by filtering Task accounts on the
`developer` field, and each terminal transition also emits an event.

If a dedicated `WorkRecord` is still wanted, it would be a PDA with seeds
`["work_record", task_pda]`, created only on a `SETTLED` transition and paid for
by that transaction's signer.

### 3.8 Attestation account — not needed

Option B does not need a separate attestation account. The attestation is a state
change on the Task (`verified_at`, state `UNDER_REVIEW`) bound to
`task.evidence_hash`.

### 3.9 Instruction set

| Instruction | Signer | Option |
|---|---|---|
| `initialize_platform` | Program upgrade authority | A, B |
| `update_platform` | Platform authority | A, B |
| `create_task` | Client | A, B |
| `cancel_task` | Client | A, B |
| `accept_task` | Developer | A, B |
| `submit_work` | Developer | A, B |
| `attest_verification` | Attester | B |
| `approve_task` | Client | A, B |
| `reject_task` | Client | A, B |
| `expire_review` | Anyone | A, B |
| `refund_task` | Client | A, B |
| `resolve_dispute` | Platform authority | A, B |
| `expire_dispute` | Anyone | A, B |

Changes from `02-ONCHAIN-SPEC.md` and why: `fund_task` is merged into
`create_task` (D11.1); `open_dispute` is removed (D3); `release_payment` is part
of `approve_task`; `cancel_task`, `refund_task` and `expire_dispute` are added
for the exit paths and the dispute fallback (D3, D4); `update_platform` is added
for authority rotation (D11.3).

---

## 4. Atomic create + fund (APPROVED principle, PROPOSED detail)

`create_task(task_id, amount, work_duration)` is a single instruction:

1. Anchor validates the accounts: `client` is a signer; `platform` matches its
   seeds; `usdc_mint` has the address stored in `platform.usdc_mint`; the source
   token account has that mint and is owned by `client`.
2. The Task PDA is created with `init` (payer: client). If it already exists the
   instruction fails, so a `task_id` cannot be replayed.
3. The escrow token account PDA is created with `init` (payer: client), mint
   `usdc_mint`, authority the Task PDA.
4. `transfer_checked` moves `amount` from the client's token account to escrow,
   authorised by the client's signature, with the mint's decimals.
5. The escrow balance is reloaded and required to equal `amount`.
6. Task fields are written, config values are snapshotted, state is set to `OPEN`
   and an event is emitted.

Failure and rollback: every step runs inside one transaction. An insufficient
balance, a wrong mint, an existing Task PDA or any failed check reverts the whole
transaction, including account creation and rent. A partially funded task cannot
exist.

Database side: the draft row already holds `task_id` and the client wallet, so
the API derives the Task PDA and reads it. The on-chain amount and duration are
authoritative; if they differ from the draft, the on-chain values are recorded
and the difference is surfaced, never overwritten.

---

## 5. Task ID (PROPOSED)

**Choice: 16-byte UUID (version 4).**

| Aspect | Definition |
|---|---|
| Generation | By the API when the draft is created (`crypto.randomUUID()`). |
| Database | PostgreSQL `uuid`, primary key of the task. |
| On-chain | `[u8; 16]`: the UUID's 16 bytes in network (big-endian) order, i.e. the hex digits of the canonical string read left to right. |
| PDA seeds | `["task", client_pubkey (32 bytes), task_id (16 bytes)]` |
| Mapping | `(client wallet, uuid) → Task PDA` is a pure function, computed identically by the SDK, the API and the program. |

Why not `u64`: a sequential `u64` needs a global counter account that every
`create_task` writes to (contention, and a draft could not know its ID before
funding), or a client-chosen number with no natural database key. A UUID is
created with the draft and needs no on-chain coordination.

Why `client_pubkey` is in the seeds: without it, anyone who learns a draft's UUID
could create the Task PDA first and block the real client. With it, a PDA can only
be created by the wallet it is derived from.

---

## 6. Money rules (APPROVED)

- All amounts are `u64` token base units (USDC has 6 decimals: 100 USDC =
  `100_000_000`). TypeScript uses `bigint`. No floating point anywhere.
- `fee = floor(amount * fee_bps / 10000)`, computed with a `u128` intermediate
  and checked arithmetic; any overflow aborts the transaction.
- Developer receives `amount - fee` (plus any stray balance, §3.3).
- Example: amount `100_000_000`, `fee_bps = 250` → fee `2_500_000` (2.50 USDC),
  developer `97_500_000` (97.50 USDC).
- Refunds and cancellations carry no fee.
- `fee_bps` is snapshotted per task at creation.

---

## 7. Verification gate (D2) — analysis and recommendation

### 7.1 Concept A: off-chain verification

Off-chain verification is performed by the API against the GitHub REST API and
stored in PostgreSQL.

| Element | Definition |
|---|---|
| GitHub evidence | Repository (`owner/name`, bound to the task at creation), PR number, PR author, `merged_by`, merge commit SHA, merge timestamp, repository `created_at`. |
| Verification status | `PENDING`, `VERIFIED` or `REJECTED`, with one auditable reason per failed rule (§10). |
| Evidence hash | SHA-256 of the canonical JSON in §10.3. The same value the developer records on-chain. |
| Verification timestamp | UTC time the check ran, stored with each result. Results are append-only; a re-check adds a row. |
| Verifier identity | The API deployment and rule-set version that produced the result, plus the GitHub response metadata it was based on. Under Option B, also the attester public key and the attestation transaction signature. |
| Failure / PENDING | A GitHub API error, rate limit or timeout produces `PENDING` and is retryable. It never produces `VERIFIED`. A rule that fails on real data produces `REJECTED`. |

Off-chain verification by itself moves no money. It informs the client, and under
Option B it is the input to the attestation.

### 7.2 Concept B: on-chain authorization

| Question | Answer |
|---|---|
| Who may trigger each instruction? | See §3.9 and §2.3. |
| What can the program verify independently? | Signers; account ownership; PDA derivation; token mint and token-account owners; the task state; the on-chain clock against stored deadlines; that a supplied hash equals the stored hash; arithmetic. |
| What can it not verify? | Anything about GitHub: whether a PR exists, is merged, by whom, in which repository, or what the 32 bytes of `evidence_hash` are a hash of. |
| What must be trusted from the backend? | Option A: nothing on-chain; the backend is advisory. Option B: that the attester key signs `attest_verification` only for evidence that passed §10. |
| Is an attestation authority necessary? | Only if the requirement "review expiry must not pay unverified work" is to be enforced on-chain. There is no other way for the program to learn a GitHub fact. |
| Trust boundary | The program trusts signatures and its own state, never request bodies or database rows. Under Option B the single trusted off-chain input is one bit per task ("this hash is VERIFIED"), signed by one key that cannot move funds. |

### 7.3 Option A — no attester

Verification is advisory. `expire_review` always pays the recorded developer once
the review window has passed.

**Consequence: this option cannot enforce "expiry must not pay unverified
work".** The only protection for a client is to reject within the review window.

| Threat | Result under Option A |
|---|---|
| Developer submits a junk hash; client is absent for the review window | **Developer is paid.** No on-chain defence. |
| Automated abuse: a bot accepts tasks and submits junk immediately | Works against every client who does not respond within the window. Costs the attacker only transaction fees. |
| Client is attentive and rejects junk | `DISPUTED`; platform authority refunds. Each case needs manual resolution. |
| Client absent, work genuine | Developer is paid on expiry. Correct. |
| Client rejects genuine work | `DISPUTED`; platform authority decides. |
| Backend or database compromise | No direct fund impact. Attacker can show false verification status in the UI and mislead a client into approving. |
| Privileged key compromise | Only the platform authority exists; see §7.5. |
| GitHub outage | No on-chain effect; status shows `PENDING`. |

Trust required: clients must monitor every submission within the review window.

### 7.4 Option B — minimum-permission attester

One key may call `attest_verification(evidence_hash)`. The review window starts
only when that attestation exists. Without it, the task can be approved by the
client or, after `verification_deadline`, refunded to the client.

| Property | Definition |
|---|---|
| Permission | Exactly one instruction. It sets `verified_at` and moves `SUBMITTED → UNDER_REVIEW` when the supplied hash equals `task.evidence_hash`. It has no token accounts in its account list. |
| Key storage | A dedicated keypair held as a `SECRET` in the API host's secret store. Never in the repository, the database, logs or the frontend. Holds only enough SOL for fees. |
| Separation | Distinct from the platform authority (held by a person in a wallet, never on a server) and from the treasury wallet. |
| Rotation | Platform authority calls `update_platform` with a new attester public key; the old key stops working immediately. Attestations already recorded stay valid. |
| Compromise impact | The attacker can mark any `SUBMITTED` task VERIFIED. That only starts the review window; the client can still reject, and disputes go to the platform authority. **Worst case equals Option A's normal behaviour.** The attacker cannot move funds, change destinations, change config or resolve disputes. |
| Unavailability | If the attester is down, work cannot enter review. The client can still approve directly. If it stays down past `verification_deadline`, the client can take a refund even for genuine work. |

| Threat | Result under Option B |
|---|---|
| Developer submits a junk hash; client is absent | No attestation. No payment. Client refundable after `verification_deadline`. |
| Automated junk submissions | Cannot reach payment. |
| Client absent, work genuine and verified | Attested; developer paid on review expiry. Correct. |
| Client rejects verified work | `DISPUTED`; platform authority decides; fallback per §8. |
| Colluding developer + attester | Junk is attested and the review window starts. The client can still reject; an absent client loses the escrow. Equal to Option A. |
| Attester key stolen | Same as collusion, for every `SUBMITTED` task, until rotated. Equal to Option A for the exposure period. |
| Attester down or censoring | Genuine work is not attested. A cooperative client approves directly; an uncooperative client is refunded after `verification_deadline`. **New risk introduced by Option B.** |
| Backend or database compromise without the key | No on-chain effect. |
| Backend compromise with the key | As "attester key stolen". |
| GitHub outage | Verification stays `PENDING`; no attestation. `verification_grace` gives time to retry. A prolonged outage becomes the "attester down" case. |
| Client refuses to merge the PR | Evidence can never become VERIFIED (§10 requires a merge by someone other than the author). No attestation, no dispute path; client is refunded. See U2 in §16. |

Residual trust assumptions: the attester signs only for evidence that passed §10;
the API host keeps the key confidential; the attester is available within
`verification_grace`; GitHub's API reports truthfully.

Absent-client scenario: verified work is paid on expiry by anyone calling
`expire_review`. Unverified work is not paid; the escrow waits for the client to
call `refund_task`.

Cost of Option B over Option A: one instruction, one state, two config fields,
one hot key to operate and fund, and the liveness dependency above.

### 7.5 Threats common to both options

| Threat | Result | Mitigation |
|---|---|---|
| Platform authority compromised | Can resolve `DISPUTED` tasks either way, change the fee and windows for **new** tasks, redirect future fees, replace the attester. Cannot touch tasks that are not `DISPUTED`; cannot send escrow to a third party. | Hardware or multisig wallet; snapshots protect funded tasks. |
| Platform authority unavailable | Disputes are not resolved. | Permissionless `expire_dispute` (§8). |
| Program upgrade authority compromised | Can replace the program and take all escrow. | Same custody as the platform authority; residual risk of any upgradeable program. |
| `initialize_platform` front-run | Attacker would own the config. | Signer must be the upgrade authority. |
| Fake mint or fake token account | Would let worthless tokens stand in for USDC. | Mint pinned in Platform; every token account constrained by mint and owner. |
| Stray deposit into escrow | Would block closing the account. | Terminal transitions sweep the whole balance (§3.3). |
| Treasury account closed or frozen | Developer-paying settlements fail. | Authority rotates the treasury; refund paths are unaffected. |
| Accept-squatting | A wallet accepts tasks and never submits, locking each until its work deadline. Costs only fees. | None in the MVP. See U4 in §16. |
| Developer resubmits during review | Client approves evidence they did not see. | T5 is blocked after attestation; T9 checks the hash. |
| Validator clock drift | Deadlines shift by seconds. | Windows are hours or days. |
| USDC issuer freezes an account | Funds in that account are stuck. | Outside Taskra's control. |

### 7.6 Recommendation (awaiting approval)

**Recommend Option B.**

1. Option A leaves a theft path that needs no skill and can be automated: accept,
   submit junk, wait. Its only defence is that every client responds to every
   submission within the review window. That contradicts the product's central
   claim that evidence, not inattention, produces settlement.
2. Option B's worst case — the attester key stolen, or attester and developer
   colluding — is exactly Option A's everyday behaviour. The key cannot move
   funds, so adding it cannot make fund safety worse than not having it.
3. The new risk is liveness: an unavailable attester can cost a developer a
   payment if the client is also uncooperative. This is bounded by direct client
   approval, by `verification_grace`, and by being operational, not adversarial.

What approval of Option B would authorise: the `attester` and
`verification_grace` fields, the `UNDER_REVIEW` state, `attest_verification`,
and one `SECRET` environment variable for the attester keypair. None of these
exist today.

---

## 8. Dispute timeout fallback (PROPOSED)

`expire_dispute` is permissionless and callable once
`now > disputed_at + dispute_timeout`. `dispute_timeout` is a Platform value set
in `initialize_platform` and snapshotted per task. Proposed default: **7 days**.

The outcome must be fixed in the program. The two candidates:

| Outcome | Who it protects | Who it exposes |
|---|---|---|
| Pay developer (fee applies) | A developer whose work the client rejected in bad faith. | A client who correctly rejected bad work while the platform was unavailable. |
| Refund client (no fee) | A client who correctly rejected bad work. | A developer whose genuine work was rejected in bad faith. |

**Proposal, tied to the verification option:**

- **Under Option B: pay the developer.** A task can only reach `DISPUTED` after a
  VERIFIED attestation, meaning a PR by the developer was merged into the
  client's own repository by someone other than the developer, on time. The
  objective evidence favours the developer, and the product's stated goal is to
  bound the client's unilateral power. Destination: the developer's ATA, with the
  fee to treasury.
- **Under Option A: refund the client.** With no attestation the program has no
  evidence that the submission is real, so the neutral outcome is to return the
  funds to where they came from; nobody gains money they did not have.
  Destination: the client's ATA.

In both cases the destination is fixed by the task's recorded parties and the
caller chooses nothing.

---

## 9. "Valid submission" (PROPOSED; depends on D2)

- **Under Option A:** a `submit_work` instruction, signed by the recorded
  developer, that succeeded with `now ≤ work_deadline` and a non-zero 32-byte
  evidence hash. The program cannot judge the evidence itself. A junk submission
  therefore counts as a submission and blocks the missed-deadline refund; the
  client's remedy is `reject_task`.
- **Under Option B:** the above **and** a VERIFIED attestation for that exact
  evidence hash recorded with `now ≤ verification_deadline`. Without it the
  client may refund through T8.

Proposed default for `verification_grace`: **24 hours**.

---

## 10. Evidence verification rules (APPROVED)

Implemented in Phase 4. Recorded here so that the rules exist before the code.

### 10.1 Rules

| # | Rule | On failure |
|---|---|---|
| R1 | The URL is a GitHub pull request. | REJECTED |
| R2 | The PR targets exactly the repository named in the task. | REJECTED |
| R3 | The repository exists and its `created_at` is earlier than the task's creation timestamp. This is the definition of "pre-existing history". | REJECTED |
| R4 | The pull request exists and is merged. | REJECTED (PENDING is not used for "not merged yet"; the developer resubmits) |
| R5 | The PR author is the GitHub identity connected to the developer's wallet. | REJECTED |
| R6 | `merged_by` differs from the PR author. Self-merge is REJECTED. | REJECTED |
| R7 | The merge timestamp is after task acceptance. | REJECTED |
| R8 | The merge timestamp is at or before the work deadline. | REJECTED |
| R9 | Any GitHub API failure, rate limit or timeout. | PENDING, retryable; never VERIFIED |

CI or test status is **informational only**. It is displayed and is not a
verification condition.

Taskra verifies evidence against these predefined conditions. It does not claim
that a merged PR proves the work is objectively correct.

### 10.2 Statuses

`PENDING` (not yet determined, retry), `VERIFIED` (all of R1–R8 hold), `REJECTED`
(at least one of R1–R8 fails on real data). Every result stores which rules
passed and failed.

### 10.3 Evidence hash

`evidence_hash = SHA-256(UTF-8 bytes of the canonical JSON)`

Canonical JSON is one object with exactly these three members, serialised as
follows:

- Keys in ascending lexicographic order: `merge_commit_sha`, `pr_number`, `repo`.
- No whitespace anywhere outside string values.
- `merge_commit_sha`: string of 40 lower-case hexadecimal characters.
- `pr_number`: JSON integer, no leading zeros, no fraction, no exponent.
- `repo`: string `owner/name`, ASCII lower-cased (GitHub names are
  case-insensitive), no scheme, host or trailing `.git`.
- No other members; no escaping is ever needed because every permitted character
  is plain ASCII.

Example input:

```json
{"merge_commit_sha":"0123456789abcdef0123456789abcdef01234567","pr_number":42,"repo":"octo-org/parser"}
```

The digest is stored as 32 raw bytes on-chain and as 64 lower-case hex characters
in the database.

---

## 11. Transaction confirmation policy (APPROVED)

| Commitment | Used for | Meaning in Taskra |
|---|---|---|
| `confirmed` | UI transaction progress | The UI may show "confirmed" and advance the flow. The database may record the transaction as observed. |
| `finalized` | Authoritative financial records | Only at `finalized` does the backend write a settlement, refund or reputation change as authoritative. |

Until a settlement transaction is finalized, the database holds it as a pending
observation and no reputation aggregate includes it. The API never reports a
critical mutation as successful on the basis of a submitted-but-unconfirmed
signature, and the UI never shows success for a failed transaction.

---

## 12. Authority separation (APPROVED)

Platform authority, treasury wallet and (if approved) attester are three
different keypairs with the powers listed in §3.6. Only the platform authority
can change the stored references to them, through `update_platform`. No backend
service holds the platform authority or treasury keys. No attester key exists
until D2 is approved.

---

## 13. Toolchain and version matrix

| Tool | Pinned version | Why this version | Windows host | WSL Ubuntu 26.04 |
|---|---|---|---|---|
| Rust | 1.89.0 | MSRV of `anchor-lang` 1.1.2 and the channel `anchor init` 1.1.2 writes to `rust-toolchain.toml`. | 1.98.1 only | 1.98.1 only — **1.89.0 not installed** |
| Solana CLI (Agave) | 3.1.10 | The version Anchor's own CI pins at tag `v1.1.2`; also the version the Anchor 1.0.0 release notes recommend. | not installed | 3.1.10 installed |
| Anchor CLI | 1.1.2 | Already installed with its matching Solana CLI; Phase 1 needs nothing from a newer release. | not installed | 1.1.2 installed |
| AVM | 1.1.2 | Ships with the Anchor release. | not installed | 1.1.2 installed |
| Node.js | 24.18.1 | Satisfies Next.js 16.3.8, Vitest 5.0.3 and ESLint 10.11.0; the version Phase 0 was validated on. | 24.18.1 | 24.10.0 — **24.18.1 not installed** |
| pnpm | 12.3.4 | `packageManager` field in `package.json`. | 12.3.4 | **not installed** (only the Windows shim is visible through interop) |
| PostgreSQL | 17.11 (`postgres:17.11-alpine3.24`) | Pinned image tag. | via Docker | via Docker |
| Docker | 29.7.2 | Detected; not pinned by the repository. | 29.7.2 | via Docker Desktop integration |

Anchor 1.2.0 (which recommends Solana CLI 4.1.2) was released on 2026-09-04. It
is deliberately not selected: 1.1.2 and its matching Solana CLI are already
installed, and upgrading would require system installs for no Phase 1 benefit.

The program's Solana platform-tools (the SBF compiler) are **not yet downloaded**
in WSL; the first `anchor build` downloads them into `~/.cache/solana`.

### 13.1 Commands awaiting approval

Nothing below has been run. All run inside WSL Ubuntu as the normal user.

```bash
# 1. Pinned Rust toolchain (rust-toolchain.toml would otherwise trigger this implicitly)
rustup toolchain install 1.89.0 --profile minimal --component rustfmt --component clippy

# 2. Pinned Node.js
nvm install 24.18.1
nvm alias default 24.18.1

# 3. Pinned pnpm, native to WSL
npm install --global pnpm@12.3.4

# 4. Move the repository into the WSL filesystem (the Windows copy is left untouched)
rsync -a --exclude node_modules --exclude .next --exclude dist \
  /mnt/c/Users/User/Desktop/Taskra/ ~/taskra/

# 5. Install and validate
cd ~/taskra
pnpm install --frozen-lockfile
anchor build        # first run downloads Solana platform-tools into ~/.cache/solana
pnpm anchor:fmt
pnpm anchor:lint
```

Step 4 copies `target/deploy/taskra-keypair.json`, the local program-address
keypair created in Phase 0. It is git-ignored, controls no funds and no
authority, and only fixes the address in `declare_id!`. If it is not copied,
`anchor keys sync` generates a new one and rewrites the address.

---

## 14. Environment

The variable contract, with `PUBLIC` / `SERVER_ONLY` / `SECRET` labels, is in
`docs/10-ENVIRONMENT-SPEC.md` and `.env.example`. It is enforced by the typed
loader in `packages/shared/src/env` and its tests.

---

## 15. Minor points resolved with engineering judgment

These do not affect money, security or architecture.

| Point | Resolution |
|---|---|
| `GITHUB_WEBHOOK_SECRET` in the environment spec | Removed. The MVP verifies on demand through the REST API and uses no webhooks. It returns, as a `SECRET`, if webhooks are ever introduced. |
| Session secret | Not added. The wallet-authentication design belongs to Phase 3 and decides whether one is needed. |
| Extra variables | `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOLANA_RPC_URL` were added because the API and browser cannot run without them. `POSTGRES_*` exist only for the local docker-compose database. |
| Migration tool | `node-pg-migrate` with plain SQL migrations. It prescribes no ORM. |
| Program test runner | LiteSVM through `cargo test`, the Anchor 1.x default. Its in-process clock control is what makes deadline tests deterministic. |
| Worker process | None. Expiry instructions are permissionless and the API reconciles chain state on request. |
| API framework | Fastify. |

---

## 16. Unresolved issues affecting money or security

| # | Issue | Why it matters | Proposal |
|---|---|---|---|
| U1 | **Work deadline definition.** The product spec says "Deadline: 48 hours" without saying from when. | Decides when the client's refund opens and when submissions close. | Store `work_duration` at creation; `work_deadline = accepted_at + work_duration`. The developer always gets the full duration, and an `OPEN` task never expires by itself (the client cancels). |
| U2 | **The client controls the merge.** Under D12 evidence is only VERIFIED when someone other than the author merges the PR into the client-named repository. | A client can decline to merge, use the code anyway, and be refunded. Under Option A the developer can still submit and reach a dispute; under Option B there is no path to a dispute without a merge. | Needs a product decision. One minimal candidate: let the developer open a dispute from `SUBMITTED` before `verification_deadline`. Not adopted. |
| U3 | **Task terms are not bound on-chain.** Description, acceptance criteria and the target repository live only in the database. | Whoever controls the database could change the target repository after funding and alter what counts as valid evidence. | Add `terms_hash: [u8; 32]` (SHA-256 of canonical task metadata) to `create_task` and the Task account. |
| U4 | **Accept-squatting.** Accepting costs nothing, and acceptance is exclusive. | A bot can lock every task until its work deadline. No funds are lost, but the marketplace can be stalled. | Accept as a documented MVP limitation. A developer bond would fix it and is out of MVP scope. |
| U5 | **Dispute fallback outcome and timeout** (§8). | Decides who is paid when the platform is unavailable. | Pay developer under Option B; refund client under Option A; 7 days. |
| U6 | **`verification_grace` default** (§9, Option B only). | Too short and GitHub outages cost developers; too long and clients wait for refunds. | 24 hours. |
| U7 | **WorkRecord** (§3.7). | The on-chain spec lists it; the recommendation is not to create it. | Use the terminal Task account as the record. |
| U8 | **Minimum task amount.** | Below 40 base units the 2.5% fee floors to zero. | No minimum on-chain; `amount > 0` only. The API may impose a sensible minimum later. |
| U9 | **Custody of the platform authority and program upgrade authority.** | These keys can resolve disputes and upgrade the program. | A hardware wallet for the demo; a multisig before any real funds. Needs the owner's decision. |

---

## 17. Phase 0 status

Phase 0 delivers the repository foundation only: workspace, tooling, environment
contract, a minimal web page, an API health endpoint, a local PostgreSQL with an
empty migration setup, and an Anchor workspace whose program declares no
instructions. Validation results are in the Phase 0 report and summarised in
`README.md`.

The Anchor build, clippy and program tests are **blocked** until the commands in
§13.1 are approved and run. Phase 1 does not start until the items in §16 and the
recommendation in §7.6 are decided.
