# Taskra — API Specification

The API exposes only the operations the MVP needs. Layer boundaries are in
`14-API-CONTRACT.md`; this document is the endpoint reference for the
implementation in `apps/api`.

- Base path: `/api/v1`. `/health` and `/ready` are unversioned.
- Bodies and responses are JSON. Amounts, durations and every `u64`/`i64` are
  **decimal strings**; nothing financial is a JSON number.
- Task state names are those in `13-DECISIONS.md` §2. `DRAFT` means no Task
  account has been observed on-chain.
- The API never signs or sends a user's transaction, and holds no key.

## 1. Conventions

### Errors

Every error has one shape and never contains a stack trace, SQL or
configuration:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid.", "details": [] } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` | Malformed body, unknown field, bad value |
| 401 | `UNAUTHENTICATED`, `INVALID_CHALLENGE`, `INVALID_SIGNATURE` | No session, or sign-in failed |
| 403 | `FORBIDDEN`, `CSRF_ORIGIN` | Wrong wallet for this operation, or wrong request origin |
| 404 | `NOT_FOUND`, `TRANSACTION_NOT_FOUND` | Unknown resource; transaction not visible at `confirmed` yet |
| 409 | `NO_SUBMISSION`, `STALE_SUBMISSION`, `EVIDENCE_LOCKED` | Conflicts with existing or on-chain state |
| 422 | `TRANSACTION_MISMATCH`, `TRANSACTION_FAILED`, `REASON_MISMATCH` | The transaction is not what the request says it is: it does not call the program, carries no instruction for this task or more than one, or is not the expected instruction |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL` | Unexpected; details are logged, not returned |
| 503 | `RPC_UNAVAILABLE`, `GITHUB_NOT_CONFIGURED` | A dependency is unavailable; `Retry-After` is set for RPC |

### Authentication

Wallet sign-in yields a session cookie (§2). A wallet address in a body or query
is never treated as identity. Endpoints marked **session** need the cookie.

### CSRF and CORS

- CORS allows exactly `WEB_ORIGIN`, with credentials.
- Every non-`GET` request must carry `Origin: <WEB_ORIGIN>`, or it is refused
  with `403 CSRF_ORIGIN` before any handler runs.
- The session cookie is `HttpOnly; SameSite=Strict`, and `Secure` whenever
  `WEB_ORIGIN` is https. The web app and the API must be served from the same
  site (same registrable domain).
- The API refuses to start if `WEB_ORIGIN` is neither https nor a loopback
  address, so a deployed API cannot issue a session cookie that travels in clear
  text. This does not depend on `NODE_ENV`.

### Rate limits

Per client address: 300 requests/minute overall; 20/minute on sign-in
endpoints; 30/minute on writes; 10/minute on evidence registration.

### Confirmation policy

`13-DECISIONS.md` §11. A reported transaction is recorded as:

| `status` | Meaning |
|---|---|
| `CONFIRMED` | Succeeded at `confirmed`. A pending observation; nothing financial is derived from it. |
| `FINALIZED` | Succeeded and final. |
| `FAILED` | Executed and failed; `error` is the decoded program error name. |
| `DROPPED` | Was confirmed, then disappeared (fork or expiry). |

A `settlement` appears on a task only when both the outcome transaction and the
Task account have been read at `finalized`.

## 2. Authentication

### `POST /api/v1/auth/challenge`
Body `{ "wallet": "<base58>" }`. Returns `{ nonce, message, expiresAt }`.
`message` is the exact text to sign: it names the web origin, the wallet, the
cluster and a 256-bit single-use nonce, and expires after 5 minutes.

### `POST /api/v1/auth/verify`
Body `{ "nonce", "signature": "<base58 Ed25519 signature of message>" }`.
The nonce is consumed atomically **before** the signature is checked, so each
challenge can be answered once, whatever the result. On success sets the
session cookie and returns `{ wallet, expiresAt }`. Sessions last 24 hours
(absolute, no renewal).

### `GET /api/v1/auth/session` — session
Returns `{ wallet, expiresAt, github: { login } | null }`.

### `POST /api/v1/auth/logout`
Revokes the session and clears the cookie.

## 3. Tasks

### `POST /api/v1/tasks` — session (T0)
Creates a draft. Body:

```json
{ "title": "...", "description": "...", "repo": "owner/name",
  "acceptanceCriteria": "...", "workDuration": "172800", "amount": "100000000" }
```

- Authorization: the session wallet becomes the client.
- Validation: `repo` must be `owner/name` (lower-cased); criteria are
  NFC-normalized and trimmed; `amount` in `[1, 2^64−1]`; `workDuration` between
  1 second and 365 days (the program's `MAX_WORK_DURATION`).
- The server generates the task UUID and derives `termsHash` and `taskAddress`.
  Metadata is immutable afterwards.
- Side effects: one `tasks` row. Nothing on-chain; no funds.
- Returns `201 { task }`.

### `GET /api/v1/tasks`
Query: `state`, `client`, `developer`, `limit` (≤100), `offset`. Served from the
cache; each task carries `observed: { commitment, slot, at }`. Drafts are listed
only to their own client.

### `GET /api/v1/tasks/:id`
Reads the Task account from Solana for this response and returns metadata, the
on-chain fields (`chain`), `transactions`, `settlement`, `rejection` and
`verification`. `chainSource` is `live`, or `cache` when the RPC endpoint is
unreachable (then `chain` is `null` and the cached state is shown). A draft is
visible only to its client.

### `GET /api/v1/tasks/:id/verification`
The submissions registered for the task, each with its latest verification
result, rule-by-rule reasons and attestation status.

### Reporting a transaction — session

| Endpoint | Instruction it must be |
|---|---|
| `POST /api/v1/tasks/:id/fund` | `create_and_fund_task` |
| `POST /api/v1/tasks/:id/accept` | `accept_task` |
| `POST /api/v1/tasks/:id/approve` | `approve_task` |
| `POST /api/v1/tasks/:id/reject` | `reject_task` |
| `POST /api/v1/tasks/:id/transactions` | any Taskra instruction for this task (cancel, refund, disputes, expiries) |

Body `{ "signature": "<base58>" }`; `reject` also takes `"reason"`.

- The request contributes only the signature. The API fetches the transaction
  from its own RPC endpoint and requires: exactly one top-level Taskra
  instruction; its task account equals this task's derived address; and, on the
  specific routes, the instruction named above.
- Idempotency: keyed by signature and task. Repeating a report, or reporting
  while the API is reconciling, changes nothing. A transaction that carries
  instructions for several tasks can be reported to each of them.
- Side effects: one `onchain_transactions` row; the task cache is refreshed; a
  `settlements` row is written if and only if the outcome is finalized.
- Settlement amounts are the task's own amount and fee from the finalized Task
  account, divided as the program divides them. They are recorded only when
  the token transfers that the task's outcome instruction itself made out of
  the task's escrow (its inner instructions, signed by the Task PDA) bear that
  out. Anything else in the transaction is ignored: other instructions,
  instructions for other tasks, extra transfers, and tokens deposited into the
  escrow and swept out with the principal neither change nor prevent the
  record. If the RPC endpoint does not report inner instructions, nothing is
  recorded and the next read retries.
- Not supported: a settlement whose outcome instruction was invoked by another
  program. It is not recorded (`13-DECISIONS.md` §17.4).
- `reject`: only the task's client; the reason is stored only if its SHA-256
  equals the hash the transaction recorded.
- Returns `{ transaction: { signature, instruction, status, error }, task }`.

A report is a hint, not a requirement: `GET /api/v1/tasks/:id` finds a finalized
outcome transaction by itself when nobody reported it.

### `POST /api/v1/tasks/:id/evidence` — session
Body `{ "prNumber": 42, "signature": "<submit_work signature, optional>" }`.

- Authorization: the session wallet must be the task's on-chain developer.
- The evidence hash and submission nonce are read from the Task account. If a
  `signature` is given it must be a `submit_work` for this task whose hash is
  still the current one (`409 STALE_SUBMISSION` otherwise).
- Side effects: one `submissions` row per `(task, nonce)` and one queued
  verification job. Repeating the request re-queues a finished job that produced
  no attestation (for example after the pull request was merged).
- Repeating the request with a different `prNumber` corrects the registration
  while the submission has no VERIFIED result and no attestation; after that it
  answers `409 EVIDENCE_LOCKED`. A correction cannot make a wrong pull request
  verify: the on-chain hash commits to the repository, the number and the head
  commit. Every verification run records the number it examined.
- The pull-request number is a claim. The verifier recomputes the evidence hash
  from GitHub and compares it with the chain (`13-DECISIONS.md` §10, R9).

## 4. Users

### `GET /api/v1/users/:wallet`
`{ wallet, registered, github: { login } | null }`.

### `GET /api/v1/users/:wallet/reputation`
Aggregates over **finalized** settlements, labelled `Off-chain aggregate`:
developer and client counts and totals, the Reliable Contributor milestone
(3 settled tasks from 3 distinct clients; no reward is attached), and the most
recent verified work with settlement signatures. `developer.tasksSettled` counts
every settled task; `developer.tasksVerified` and `verifiedWork` include only
settlements whose final submission carried a valid attestation. A task the
client approved without verification is settled, not verified.

## 5. GitHub identity

### `GET /api/v1/github/connect` — session
A top-level navigation. Redirects to GitHub's OAuth authorization page with a
single-use `state` bound to the wallet and to this browser. No scope is
requested.

### `GET /api/v1/github/callback`
Exchanges the code, asks GitHub for the user's numeric id and login, stores the
link, discards the token, and redirects to
`<WEB_ORIGIN>/profile/<wallet>?github=linked` (or `state_invalid`,
`exchange_failed`, `already_linked`).

## 6. Operations

### `GET /health`
Liveness. `{ "status": "ok" }`. Touches no dependency.

### `GET /ready`
Readiness. `200 { status: "ready", checks: { database, rpc } }` or `503` naming
which dependency is unavailable, and nothing else.
