# Taskra — Database Specification

PostgreSQL 17, migrated with `node-pg-migrate` and plain SQL
(`13-DECISIONS.md` §13). The schema is `apps/api/migrations/`; this document is
its specification and the two must agree. No ORM is used: every query is a
parameterized statement through `pg`.

Task state names are those in `13-DECISIONS.md` §2. The task primary key is the
UUID defined in `13-DECISIONS.md` §5.1.

## 1. Authority

The database is never authoritative for money or task state
(`14-API-CONTRACT.md` §5).

| Data | Authority | In the database |
|---|---|---|
| Task existence after funding, parties, amount, fee, state, outcome, deadlines, nonce, hashes, attestation | On-chain Task account | `tasks.chain_*`: a cache tagged with the slot and commitment it was read at. Rewritten from the chain on every read of a task. |
| How a task's escrow was divided | Solana | `settlements`: the task's amount and fee, split as the program splits them, recorded only when a **finalized** outcome instruction's own escrow transfers bear it out (`13-DECISIONS.md` §17.4). Never a balance, and never a sum of transfers. |
| Whether a transaction happened | Solana | `onchain_transactions`: an observation keyed by signature and task, with its finality. |
| Title, description, repository, acceptance criteria, work duration, amount of a draft | Database | `tasks`, bound to the chain by `terms_hash`. Immutable after insert. |
| Wallet sessions, GitHub identity links | Database | `sessions`, `github_accounts`. |
| Pull-request claims, verification runs, attestation operations, rejection reason text | Database | `submissions`, `verification_results`, `attestations`, `rejection_reasons`. The chain holds only hashes. |
| Reputation | Derived | Views over `settlements`. Recomputable from the chain. |

A task is a `DRAFT` exactly when `tasks.chain_state IS NULL`. No column says
"funded", "settled" or "refunded" other than as a copy of a chain read.

## 2. Logical entities and their tables

| Logical entity (original list) | Table / view |
|---|---|
| users, wallets | `wallets` (one wallet is one user, D19) |
| — | `auth_nonces`, `sessions` (wallet authentication) |
| tasks, task_metadata | `tasks` |
| task_evidence, github_pull_requests | `submissions` (the claim) and `verification_results` (what GitHub returned) |
| github_accounts | `github_accounts`, `github_oauth_states` |
| github_repositories | Not a table. The repository is `tasks.repo`; what GitHub reported about it is stored per run in `verification_results`. |
| verification_results | `verification_jobs` (queue), `verification_results` (append-only audit), `attestations` |
| onchain_transactions | `onchain_transactions` |
| settlements | `settlements` |
| disputes | `rejection_reasons`. Dispute state itself is on-chain. |
| reputation_snapshots | Views `developer_reputation`, `client_reputation`. A view cannot drift from the settlements it is computed from, so no snapshot is stored. |

## 3. Types

| Domain | Definition |
|---|---|
| `solana_address` | base58 text, 32–44 characters |
| `tx_signature` | base58 text, 64–88 characters |
| `sha256_hex` | 64 lower-case hex characters |
| `git_sha` | 40 lower-case hex characters |
| `token_amount` | `numeric(20,0)` in `[0, 2^64 − 1]`: token base units, exact |

All timestamps are `timestamptz` (UTC). On-chain times are stored converted from
unix seconds. Amounts cross the API as decimal strings and are `bigint` in
TypeScript; no amount is ever a JavaScript `number`.

## 4. Tables

Primary keys are marked **PK**, foreign keys **FK →**.

### wallets
`address` **PK**, `created_at`. A row is created when a wallet first completes a
signed login.

### auth_nonces
`nonce` **PK** (43 base64url characters = 256 random bits), `wallet`, `message`
(the exact text to sign), `issued_at`, `expires_at`, `consumed_at`.
Index: `expires_at`. A nonce is consumed by a single conditional `UPDATE`
(`consumed_at IS NULL AND expires_at > now()`), so it can be used at most once
even under concurrent requests.

### sessions
`token_hash` **PK** (SHA-256 of the cookie value; the token is not stored),
`wallet` **FK → wallets**, `created_at`, `expires_at`, `revoked_at`.
Indexes: `wallet`, `expires_at`.

### github_oauth_states
`state_hash` **PK**, `wallet` **FK → wallets**, `created_at`, `expires_at`,
`consumed_at`. Single-use OAuth `state`, bound to the wallet that started the
flow.

### github_accounts
`wallet` **PK, FK → wallets**, `github_user_id` **UNIQUE**, `login`,
`linked_at`. One GitHub account per wallet and one wallet per GitHub account.
The numeric id is the identity used by rule R5.

### tasks
`id` **PK** (uuid), `client_wallet` **FK → wallets**, `task_address`
**UNIQUE** (the Task PDA, derived by the API), `title`, `description`, `repo`
(canonical lower-case `owner/name`), `acceptance_criteria` (NFC-normalized and
trimmed), `work_duration` (> 0), `amount` (> 0), `terms_hash`, `created_at`,
and the cache `chain_state`, `chain_outcome`, `chain_developer`,
`chain_terms_match`, `chain_slot`, `chain_commitment`, `chain_synced_at`.
Indexes: `client_wallet`, `chain_developer`, `(chain_state, created_at DESC)`.
The API role may `UPDATE` only the `chain_*` columns.

### onchain_transactions
**PK** `(signature, task_id)`, `task_id` **FK → tasks**, `instruction`, `status`
(`CONFIRMED` | `FINALIZED` | `FAILED` | `DROPPED`), `slot`, `block_time`,
`error_code`, `error_name`, `reported_by` **FK → wallets**, `first_seen_at`,
`updated_at`. Indexes: `(task_id, first_seen_at)`; partial on
`status = 'CONFIRMED'`. A transaction can carry Taskra instructions for
several tasks; it has one row for each task it concerns, naming that task's
instruction.

### settlements
`task_id` **PK, FK → tasks**, `(signature, task_id)` **FK →
onchain_transactions**, `state` (`SETTLED` | `REFUNDED` | `CANCELLED`),
`outcome`, `client_wallet`, `developer_wallet`, `amount`, `fee_amount`,
`developer_amount`, `client_amount`, `disputed`, `accepted_at`, `closed_at`,
`slot`, `recorded_at`, `attested` (whether the task's final submission carried a
valid attestation; false for rows older than the column). Indexes: `developer_wallet`, `client_wallet`.
Written only from a transaction and a Task account both read at `finalized`.
`fee_amount`, `developer_amount` and `client_amount` always add up to `amount`
(`CHECK settlements_amounts_add_up`): tokens swept out of the escrow beyond the
task amount are not recorded and could not be stored.

### rejection_reasons
`task_id` **PK, FK → tasks**, `reason_hash`, `reason`, `author_wallet`
**FK → wallets**, `created_at`. Stored only when SHA-256 of the text equals the
`rejection_reason_hash` on the Task account.

### submissions
`id` **PK**, `task_id` **FK → tasks**, `submission_nonce`, `evidence_hash`,
`pr_number`, `submitter_wallet` **FK → wallets**, `created_at`.
**UNIQUE** `(task_id, submission_nonce)`. A trigger allows exactly one kind of
update: correcting `pr_number`, and only while the submission has no VERIFIED
result and no attestation. Every other column is immutable.

### verification_jobs
`submission_id` **PK, FK → submissions**, `status` (`QUEUED` | `RUNNING` |
`DONE`), `attempts`, `run_after`, `locked_until`, `requested_at`, `updated_at`.
Partial index on `run_after` where not `DONE`.

### verification_results
`id` **PK**, `submission_id` **FK → submissions**, `status` (`PENDING` |
`VERIFIED` | `REJECTED`), `rules` (one entry per rule with pass/fail/not
evaluated and a reason), `ruleset_version`, `verifier_version`,
`attester_pubkey`, `repo`, `pr_number`, `head_sha`, `merge_commit_sha`,
`pr_author_id`, `pr_author_login`, `merged_by_id`, `merged_by_login`,
`merged_at`, `repo_created_at`, `recomputed_evidence_hash`,
`onchain_evidence_hash`, `onchain_submission_nonce`, `onchain_slot`,
`github_meta`, `created_at`.

- **Append-only**: a trigger rejects every `UPDATE` and `DELETE`, and no role
  is granted either.
- Partial **UNIQUE** index: at most one `VERIFIED` row per submission.
- An insert trigger locks the submission row and refuses a `VERIFIED` row whose
  `pr_number` is not the one registered at that moment
  (`13-DECISIONS.md` §17.5).
- `CHECK`: a `VERIFIED` row must contain `head_sha`, `merge_commit_sha`, both
  GitHub identities, the merge time, the repository creation time, and a
  recomputed hash equal to the on-chain hash.

### attestations
`submission_id` **PK, FK → submissions**, `verification_result_id` **UNIQUE,
FK → verification_results**, `task_id` **FK → tasks**, `evidence_hash`,
`submission_nonce`, `attester_pubkey`, `status` (`REQUESTED` | `SENT` |
`FINALIZED` | `FAILED`), `signature` **UNIQUE**, `attempts`, `last_error`,
`created_at`, `updated_at`.

- The primary key allows **one attestation operation per submission**.
- An insert trigger requires the referenced result to be `VERIFIED`, to belong
  to the same submission, and to carry the same hash and nonce.
- An update trigger forbids changing what the attestation points at, and
  forbids leaving `FINALIZED` or `FAILED`.

### Views
`developer_reputation(wallet, tasks_settled, tasks_refunded, tasks_disputed,
distinct_clients, total_earned, tasks_verified)` and `client_reputation(wallet, tasks_settled,
tasks_refunded, tasks_cancelled, tasks_disputed, distinct_developers,
total_paid)`, both over `settlements`.

## 5. Idempotency and concurrency

| Event | Guard |
|---|---|
| Same transaction reported twice for a task, or reported while being reconciled | `onchain_transactions (signature, task_id)` PK; inserts use `ON CONFLICT` |
| Two outcomes recorded for one task | `settlements.task_id` PK |
| A settlement naming a transaction that is not on record for its task | `settlements (signature, task_id)` FK. One transaction may settle several tasks, once each |
| A correction of `pr_number` racing a `VERIFIED` result | Inserting the `VERIFIED` result rewrites the submission row, so the two are serialized on it and the later one is refused, at any isolation level |
| Same on-chain submission registered twice | `submissions (task_id, submission_nonce)` UNIQUE |
| Two workers verifying one submission | Jobs are claimed with `FOR UPDATE SKIP LOCKED` and a lease |
| Two `VERIFIED` results for one submission | Partial unique index |
| Two attestation operations for one submission | `attestations.submission_id` PK |
| Login nonce replay | Conditional single-row `UPDATE` |

The program is the final guard in every financial case: a second settlement or a
second attestation for the same submission is rejected on-chain.

## 6. Roles and isolation

Taskra is single-tenant, so no row-level security is specified or enabled.
Isolation is by table privilege between two group roles:

| Role | May write | May only read | No access |
|---|---|---|---|
| `taskra_api` (request handling) | `wallets`, `auth_nonces`, `sessions`, `github_oauth_states`, `github_accounts`, `tasks` (insert; update of `chain_*` only), `onchain_transactions`, `settlements` (insert), `rejection_reasons` (insert), `submissions` (insert; update of `pr_number` only), `verification_jobs` | `verification_results`, `attestations`, reputation views | — |
| `taskra_attester` (attestation service) | `verification_jobs` (update), `verification_results` (insert), `attestations` (insert, update) | `tasks`, `submissions`, `github_accounts` | everything else, including sessions |

Each service runs `SET ROLE` to its role on every connection. In development one
login (the migration owner) may assume both. **In any shared or production
deployment each service must connect with its own login that is a member of only
its own role**, so that a compromised API cannot write a verification result or
an attestation record. Privileges are a second line of defence, not the first:
the attestation service re-derives every fact from GitHub and from the chain
before it records a result (`06-GITHUB-VERIFICATION-SPEC.md`).

`SET ROLE` is a habit of the code, not a boundary: a connection can leave its
role again (`SET ROLE NONE`), and what it can do then is decided by its login.
The attestation service signs for the attestation records it finds; it does not
verify a second time before signing. With the migration login, a connection
that had dropped to `taskra_api` inserts a VERIFIED result and an attestation
record (`db.test.ts` executes this).

So on a deployment the API inspects its own login before it listens and
refuses to run (exit status 1) if the login is a superuser, may create roles,
owns tables of the schema, or is a member of `taskra_attester`, directly or
through another role; and, whatever its name and memberships, if any role it is
or can become may insert a verification result or insert or update an
attestation record (`apps/api/src/startup.ts`). If the login cannot be
inspected (no connection, no schema) the API does not start either.

A deployment is any one of: a web origin that is not a loopback address; an
`API_HOST` that is not a loopback interface; `NODE_ENV=production`. No setting
turns the check off. It is skipped only for a development process that listens
on loopback for a loopback web origin, where one login serves the migrations
and every process.

What this does not cover: the attestation service does not inspect its own
login; nothing is checked about who else holds that login's password; and a
login that is accepted at startup can be given more privileges afterwards.

## 7. Migrations

- Migrations: `1760000000000_initial-schema`, then
  `1760100000000_evidence-correction` (the `submissions` correction rule),
  `1760200000000_transactions-per-task` (one transaction, several tasks),
  `1760300000000_verified-result-matches-registration` (a VERIFIED result only
  for the registered number), `1760400000000_settlement-amounts-add-up` (a
  settlement divides the task amount and nothing else) and
  `1760500000000_settlement-attested` (settled and verified are recorded
  separately).
- `pnpm db:migrate` applies pending migrations; it needs a login that can create
  roles (the docker-compose user can).
- Migrations are forward-only in any environment holding data. The `Down`
  section exists for local development; never run it against a database whose
  contents matter.
- No manual schema changes in production.
- Tests create a throwaway database per test file from a migrated template
  (`packages/shared/src/testing/postgres.ts`), on an ephemeral PostgreSQL or on
  the server named by `TASKRA_TEST_DATABASE_URL`.

## 8. Retention

`auth_nonces`, `github_oauth_states` and expired `sessions` are deleted
opportunistically by the API after they expire. Nothing else is ever deleted.
