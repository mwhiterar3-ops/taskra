# Taskra — Security and Reliability Review

**This is a self-review by the people who wrote the code, not an independent
audit.** A second self-review after publication (§7) found three medium and
several low findings that this first one missed; a fourth (§7.7) found that one
of the fixes was incomplete; a fifth (§7.8) verified the result from a fresh clone. It records what was examined, what was found, what was fixed and what
remains. Passing tests are evidence that specific behaviours hold; they are not
a claim that the system is secure. Taskra must not hold real funds on the
strength of this document.

## 1. Scope and method

Reviewed: `apps/api`, `apps/attester`, `apps/web`, `packages/shared`, the
database schema, the scripts, and how they use `packages/sdk` and the program.

Method: reading the code against `07-SECURITY-SPEC.md`, `13-DECISIONS.md` §7.5
and `14-API-CONTRACT.md`; the automated suites; the end-to-end run against a
local validator; seeded-defect (mutation) runs; `pnpm audit`; pattern scans for
string-built SQL, HTML injection sinks, code execution and tracked key files.

### What was and was not independently verified

| Area | Status |
|---|---|
| Program logic (state machine, authorization, arithmetic, PDAs, token constraints) | Verified in Phase 1 by its own test suite, randomized sequences and `scripts/mutation-check.sh`. **Not re-reviewed line by line here.** Exercised again through `pnpm e2e`. |
| API, attestation service, web logic | Reviewed and tested as described below; mutation-checked (§4). |
| Real GitHub API and OAuth | **Not exercised.** Only a fake inside the test harnesses. |
| Web app in a real browser with a wallet extension | **Not exercised.** |
| Any public cluster | **Not exercised.** Local validator only. |
| Hosting, TLS, proxy, secret store, database hardening | **Out of scope**; requirements are in `11-DEPLOYMENT-SPEC.md`. |
| Third-party review, fuzzing of the services, penetration testing | **None.** |

## 2. Findings

Severity is for a deployment holding real value. "Fixed" means fixed in this
repository with a test; "Accepted" means a known residual risk.

### F-01 — API trusted the stored terms hash instead of recomputing it

| | |
|---|---|
| Severity | High |
| Status | **Fixed** |
| Component | `apps/api` (`termsMatch`), `packages/sdk` |
| Scenario | Someone with write access to the database changes a funded task's repository or acceptance criteria and leaves the `terms_hash` column alone. The API compared that column with the chain and kept reporting the metadata as verified. |
| Impact | Users are shown terms the client never funded; a developer could be steered to a different repository. The verifier would have used the altered repository. |
| Remediation | `termsMatchTask` in the SDK recomputes the hash from the metadata. The API, the attestation service (precondition P1) and the browser all use it. |
| Evidence | `tasks.test.ts` "is flagged when stored metadata was edited but its stored hash was left alone"; `worker.test.ts` "REJECTED without contacting GitHub when metadata does not match"; e2e F; mutation 7. |
| Residual | Draft metadata before funding is whatever the database says; the client reviews it in the wallet's own browser, which recomputes the hash before funding. |

### F-02 — Freshly published dependencies were exempted from the release-age policy

| | |
|---|---|
| Severity | Medium (supply chain) |
| Status | **Fixed** |
| Component | `pnpm-workspace.yaml`, `apps/api/package.json` |
| Scenario | Adding three Fastify plugins at their newest versions (published the previous day) made pnpm write `minimumReleaseAgeExclude` entries, silently exempting them from the workspace's minimum-release-age check. |
| Impact | A compromised fresh release would have been installed without the cooling-off period. |
| Remediation | Pinned the previous releases, removed the exemption block, rebuilt the lockfile on top of the committed one so no existing pin moved. |
| Evidence | `pnpm install --frozen-lockfile` passes the supply-chain policy check with no exclusions in `pnpm-workspace.yaml`. |
| Residual | `embedded-postgres` (test-only, pre-release versioning) runs an install script that restores symlinks in its binary distribution; it is allowed explicitly and never used by a running service. |

### F-03 — Sign-in message can be relayed by a look-alike site

| | |
|---|---|
| Severity | Medium |
| Status | Accepted |
| Component | Wallet authentication |
| Scenario | A phishing site requests a challenge for the victim's address from the real API and asks the victim to sign it. The message names Taskra's real domain, but a wallet using plain `signMessage` does not compare that with the site the user is on. The attacker submits the signature and holds a session for the victim's wallet. |
| Impact | The attacker can create drafts, register evidence metadata, post a rejection reason and change the wallet's GitHub link (which can stop that wallet's work from being verified). **They cannot move funds, sign transactions or change on-chain state.** |
| Remediation | The message states the domain, the cluster and that it is not a transaction; challenges are single-use and live 5 minutes; sessions last 24 hours. A wallet-enforced domain check (Sign-In With Solana) would close it and is not implemented. |
| Evidence | `auth.test.ts` (binding, single use, expiry). The relay itself is not prevented and has no test. |
| Residual | As described. |

### F-04 — The attestation service trusts the wallet-to-GitHub link in the database

| | |
|---|---|
| Severity | Medium |
| Status | Accepted |
| Component | `apps/attester`, `github_accounts` |
| Scenario | Rule R5 compares the pull-request author with the GitHub account linked to the developer's wallet. An attacker who can write that table (database compromise, or F-03 against the developer) links another account. |
| Impact | With a colluding developer: a pull request written by someone else is attested as theirs. That starts a review window; the client can still reject. Against an honest developer: their real work fails R5 until relinked. |
| Remediation | The attestation service connects with its own login; only the API role can write the link; everything else the service uses is re-derived from the chain or GitHub. |
| Evidence | `db.test.ts` (attester role cannot write links or tasks). |
| Residual | Inherent in keeping identity links off-chain. Within the bound of `13-DECISIONS.md` §7.5. |

### F-05 — Rate limits are per socket address

| | |
|---|---|
| Severity | Low |
| Status | Accepted, documented |
| Component | `apps/api` |
| Scenario | Behind a reverse proxy every client appears as the proxy. One abusive client exhausts the shared budget, or the limit is too loose to matter. |
| Impact | Denial of service of sign-in or writes; unauthenticated `GET /api/v1/tasks/:id` triggers RPC reads, so it can also burn RPC quota. |
| Remediation | Rate-limit at the proxy; see `11-DEPLOYMENT-SPEC.md`. Proxy-header trust is not configurable yet. |
| Evidence | `app.test.ts` "limits sign-in attempts per client" shows the limiter works per address. |

### F-06 — Unauthenticated GitHub quota is small and shared

| | |
|---|---|
| Severity | Low |
| Status | Accepted, documented |
| Component | `apps/attester` |
| Scenario | Without OAuth-app credentials the verifier has 60 GitHub requests an hour. Many submissions, or a developer re-registering evidence repeatedly (10 requests a minute are allowed), use it up. |
| Impact | Verification is delayed (PENDING). Never a wrong verdict: a rate-limit answer cannot become VERIFIED or REJECTED. Long delays can push a submission past its verification deadline. |
| Remediation | Configure `GITHUB_CLIENT_ID`/`SECRET` for the service (5000 an hour). Jobs back off and are capped at 40 attempts. |
| Evidence | `github.test.ts` (403/429 are `unavailable`), `worker.test.ts` "never turn into VERIFIED". |

### F-07 — No Content-Security-Policy on the web app

| | |
|---|---|
| Severity | Low |
| Status | Open |
| Component | `apps/web` |
| Scenario | If an injection flaw existed, nothing would limit what injected script could load or call. |
| Impact | None known: all task text is rendered as text by React, there is no `dangerouslySetInnerHTML`, and the session cookie is `HttpOnly`. The risk is defence in depth. A script running in the page could still ask the wallet to sign; the wallet's own confirmation is the last line. |
| Remediation | Add a nonce-based CSP. `X-Frame-Options: DENY`, `nosniff` and a referrer policy are set. |
| Evidence | Pattern scan: no HTML injection sinks in `apps/web/src`. |

### F-08 — Inherited dependency advisories

| | |
|---|---|
| Severity | Low in this use |
| Status | Accepted; pre-existing at the Phase 2 baseline |
| Component | Transitive dependencies |
| Detail | `pnpm audit` reports 6 advisories (2 high, 4 moderate), identical before and after this work: `bigint-buffer` (via `@solana/spl-token`, used only by test and local-chain tooling); `uuid` and `stream-json` (via `@solana/web3.js` → `jayson`); `braces` (via the Next.js ESLint plugin, development only). |
| Impact | `bigint-buffer` and `braces` are not in any running service. `jayson` is the RPC client inside the ADR-pinned `@solana/web3.js`; the affected `stream-json` and `uuid` functions are not on the code paths Taskra calls. |
| Remediation | None taken: the fixes are major-version changes inside a pinned dependency. Revisit when `@solana/web3.js` is next updated. |
| Evidence | `pnpm audit` at `a969203` and at this commit: both "6 vulnerabilities found: 4 moderate, 2 high". |

### F-09 — Task lists can be stale

| | |
|---|---|
| Severity | Low (reliability) |
| Status | Accepted, labelled in the UI |
| Component | `apps/api` cache, `apps/web` lists |
| Scenario | A transaction nobody reports (for example a third party's `expire_review`) is not reflected in `GET /api/v1/tasks` until someone opens that task. |
| Impact | A list may show an old state. The task page reads Solana directly and no financial record depends on the cache. A settlement that nobody ever views is not counted in reputation until it is viewed. |
| Remediation | Opening a task reconciles it and finds the outcome transaction by itself (e2e B). A background indexer was not built (`13-DECISIONS.md` §13: no worker). |

### F-10 — A superseded attestation is recorded as FAILED

| | |
|---|---|
| Severity | Informational |
| Status | Accepted |
| Component | `apps/attester` |
| Detail | If a developer resubmits after an attestation landed but before the service saw it finalized, the earlier operation ends as `FAILED: The submission is no longer the current one on-chain`, although its transaction did execute. The on-chain result is correct (the attestation was voided by the program) and the new submission is verified separately. |
| Evidence | Observed in e2e F. |

### F-13 — Server secrets were cached in the web app's build directory

| | |
|---|---|
| Severity | Medium |
| Status | **Fixed** |
| Component | `apps/web/next.config.ts` |
| Scenario | The web build loaded the whole root `.env` into its process. The build tool snapshots its environment into `.next/cache`, so `ATTESTER_SECRET_KEY` (and any other server variable present) was written to disk inside the web app's build directory. |
| Impact | Nothing reached browsers: the key was never in `.next/static` or the server output, and `.next` is git-ignored. But a deployment that copies `.next` whole to the web host would have carried the signing key there. |
| Remediation | The web configuration now takes only `NEXT_PUBLIC_*` from the root `.env` and deletes the server secrets from its own environment before building. |
| Evidence | Live-stack smoke test: with the key exported in the build shell and a clean cache, no file under `.next` contains the key or the database URL, and the browser bundle still carries the public program id and mint. This check is a manual script, not part of `pnpm test`. |
| Residual | A secret under a name not on the scrub list would still be cached. Build the web app in an environment that holds only its `NEXT_PUBLIC_*` variables. |

## 3. Review by area

| Area | Conclusion | Evidence |
|---|---|---|
| Wallet signature verification | Ed25519 over the exact server-built message; malformed keys and signatures return false rather than throw | `auth.test.ts` |
| Nonce generation and consumption | 256 random bits; consumed by one conditional `UPDATE` before the signature is checked; one of 8 concurrent uses succeeds | `auth.test.ts` |
| Replay protection | Login nonces single-use; reports keyed by signature; one settlement per task; one attestation per submission | `auth.test.ts`, `tasks.test.ts`, `db.test.ts`, `worker.test.ts` |
| Session security | Random 256-bit token; only its hash stored; `HttpOnly`, `SameSite=Strict`, `Secure` in production; 24 h absolute; revocable | `auth.test.ts` |
| CSRF | `SameSite=Strict` plus an `Origin` check on every non-GET request; CORS allows one origin | `auth.test.ts`, `app.test.ts`, e2e C |
| Authorization | Identity only from the session; client-only and developer-only operations checked against the on-chain parties; a session never authorizes a fund movement | `tasks.test.ts`, e2e |
| Transaction account validation | The API identifies the program, instruction and task from the transaction itself; one Taskra instruction per report | `chain.test.ts`, `tasks.test.ts`, e2e C |
| PDA derivation and ownership | Task address derived server-side from the session wallet and a server-generated UUID; account owner checked by the SDK reader; client and task id re-checked before caching | `tasks.test.ts` |
| Token and fee arithmetic | `bigint` and `numeric(20,0)` only; settlement amounts read from the transaction's balance changes and required to add up to what left escrow | `chain.test.ts`, `db.test.ts`, `amounts.test.ts`, e2e A |
| Escrow lifecycle, disputes, refunds | Enforced by the program; the services only observe. All paths exercised end to end. The first review did not find the unbounded-duration lock (§7, L-01) | Phase 1 suites, e2e A–F |
| Attestation authorization | Only `apps/attester` holds the key; it signs one instruction it builds itself; it has no listener; it refuses to start with the wrong key | `signer.test.ts`, `worker.test.ts`, e2e G |
| GitHub webhook authenticity | Not applicable: there are no webhooks | `13-DECISIONS.md` §13 |
| Untrusted repository execution | None. Responses are validated JSON; nothing is cloned, built or run | `signer.test.ts` "executes nothing fetched from GitHub", `github.test.ts` |
| Secret handling | No key or `.env` tracked; configuration errors never echo values; logs redact cookies; the API cannot load the attester key and refuses to start in production if it is present in its environment | `env.test.ts`, `app.test.ts`, e2e G |
| Database isolation | Two roles; the API cannot write results or attestations or alter task metadata; audit rows are append-only even for the owner | `db.test.ts` |
| Row-level security | Not used: single tenant. Isolation is by table privilege | `04-DATABASE-SPEC.md` §6 |
| Race conditions and idempotency | Conditional updates, unique constraints and `SKIP LOCKED` leases; tested with concurrent requests and racing workers | `auth.test.ts`, `tasks.test.ts`, `worker.test.ts` |
| RPC trust | The API believes its RPC endpoint; settlement needs `finalized` for both the transaction and the account; a lagging node cannot overwrite a newer or finalized observation | `tasks.test.ts`; assumption stated in `11-DEPLOYMENT-SPEC.md` |
| Error handling and leakage | One error shape; unexpected errors return `INTERNAL` only; readiness names a dependency, not its address | `app.test.ts` |
| Dependency and supply chain | Exact versions; install scripts denied by default; release-age policy intact (F-02); advisories inherited (F-08) | `pnpm-workspace.yaml`, `pnpm audit` |
| Frontend trust in client state | State, amounts and deadlines come from the browser's own chain read; success only at `finalized`; actions derived from chain state and re-checked by the program | `transaction.test.ts`, `actions.test.ts`, `app-context.test.tsx` |

## 4. Seeded-defect evidence

`scripts/mutation-check-services.sh` introduces one defect at a time and
requires a test to fail. Result of the last run:

| # | Seeded defect | Caught by |
|---|---|---|
| 1 | Login nonce can be used more than once | `auth.test.ts`: replayed nonce; concurrent use; wrong key spends the nonce |
| 2 | Login signature is not verified | `auth.test.ts`: signature by a different key; altered message |
| 3 | Expired sessions are accepted | `auth.test.ts`: sessions expire after their lifetime |
| 4 | Writes from other origins are accepted | `auth.test.ts`: cross-origin writes refused |
| 5 | Settlement recorded from a confirmed account | `tasks.test.ts`: nothing financial at confirmed |
| 6 | A transaction for another task is accepted | `tasks.test.ts`: refuses a transaction for a different task |
| 7 | Metadata always reported as matching the chain | `tasks.test.ts`: flagged as unverified (F-01) |
| 8 | Evidence accepted from a non-developer | `tasks.test.ts`: only the on-chain developer |
| 9 | A self-merged pull request is verified (R6) | `rules.test.ts`, `worker.test.ts` |
| 10 | Evidence hash not compared with the chain (R9) | `rules.test.ts`: changed head; arbitrary hash |
| 11 | A superseded submission is still verified (P2) | `rules.test.ts`: stale submission |
| 12 | A GitHub error status is treated as an answer (R10) | `github.test.ts`: well-formed body with HTTP 500/503/403 |
| 13 | Attestation marked final at confirmed | `worker.test.ts`: FINALIZED only with the chain |
| 14 | Web reports a confirmed transaction as final | `transaction.test.ts`: polls until finalized |
| 15 | A session for another wallet counts as signed in | `app-context.test.tsx` |
| 16 | Developer may dispute before the window opens | `actions.test.ts`: the (D, R] window |

**All 16 caught.** The first run of this check caught only 2, and that was the
most useful result of the review: see F-11. Two defects (12 and 14) genuinely
survived at first; tests were added for both.

### F-11 — The test harness reported failing suites as passing

| | |
|---|---|
| Severity | High (assurance, not runtime) |
| Status | **Fixed** |
| Component | `packages/shared/src/testing/postgres.ts` |
| Scenario | The `embedded-postgres` launcher registers an exit hook that ends the process with code 0. Loaded in the test runner's main process, it made the API and attestation-service suites exit 0 even when tests failed. |
| Impact | `pnpm test` and any CI built on it could not detect a regression in the two most security-relevant packages. No shipped behaviour was affected, and the runs recorded in this repository did pass (their logs show every test passing), but the exit status proved nothing. |
| Remediation | The harness starts the PostgreSQL binaries itself and never imports the launcher. |
| Evidence | `postgres.test.ts`: a child process that fails on purpose keeps its exit code; the mutation check now fails the suites for every seeded defect. |
| Residual | None known. The mutation check should be re-run whenever the test infrastructure changes. |

### F-12 — The attester key could sit in the API's environment

| | |
|---|---|
| Severity | Medium |
| Status | **Fixed** |
| Component | `apps/api` configuration |
| Scenario | One `.env` file serves every process in development, so `ATTESTER_SECRET_KEY` was present in the API process's environment (unused). Copying that arrangement to a server would put the signing key on the request-handling host. |
| Impact | An API compromise would then also be an attester-key compromise. |
| Remediation | In production the API refuses to start if the variable is present. Otherwise it deletes it from its own environment at startup. |
| Evidence | `app.test.ts`: "refuses to start in production when the attester key is in its environment"; e2e G starts the API process without it. |
| Residual | In development the key is still in the same file as the API's variables. |

`scripts/mutation-check.sh` does the same for the program with eight defects
(Phase 1).

## 5. Residual risks accepted for the MVP

1. Everything in `13-DECISIONS.md` §7.5 and §14: upgrade-authority trust,
   accept-squatting, the junk-submission delay, and the attester-plus-colluding-
   developer-plus-absent-client case.
2. F-03 and F-04: a session or the identity link can be abused to disrupt or to
   mis-attribute authorship, never to move funds directly.
3. Operational: one RPC endpoint is trusted; rate limits need a proxy; there is
   no monitoring or alerting beyond logs.
4. Unverified integrations: real GitHub, a real wallet extension, devnet.

## 6. Before real funds

An independent audit of the program and the attestation path; Sign-In With
Solana or an equivalent domain-bound login; a CSP; RPC redundancy; monitoring of
attestations against `verification_results`; a tested devnet deployment; and a
decision on freezing or governing program upgrades.

## 7. Second review: published commit `e82eec5`

After publication the authors reviewed the published tree again, adversarially,
including a first full read of the Anchor program and probes run against a
local validator. **This is still a self-review**: the same people wrote most of
the code under review. It found problems the first review (§2) missed, which is
the best evidence of how much a self-review is worth.

Status values: **Fixed** means a fix and a regression test exist in the
remediation branch `security/remediation-1`. **Narrowed** means the fix removes
some ways of exploiting the finding and leaves others, which are named. **The
published repository (`publish/colosseum`, `e82eec5`) does not contain any of
these fixes** until that branch is reviewed, committed and published.
"Confirmed" means the problem was executed or follows directly from the code;
"suspected" means it was reasoned about and not reproduced.

A third pass (§7.5) then reviewed the fixes themselves. It changed two statuses
in this table that the second pass had recorded as Fixed (M-01 and M-02), and
found three further problems, one of them introduced by a fix.

### 7.1 Findings

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| M-01 | Medium | Verification did not bind the pull request to the task. Any pull request by the developer, merged by someone else in the task's repository inside the work window, was VERIFIED, whatever it was about; if the client was absent, or rejected and the authority was silent, it was paid. | Confirmed from the rule set; not run against the real GitHub | **Narrowed, not fixed** (R11, R12: the head commit must name the task and the wallet; `13-DECISIONS.md` §17.2). The two lines are the developer's own declaration, so a developer can still put them on a pull request that has nothing to do with the task. What they prevent is an incidental match, one pull request serving two tasks, and retrofitting an already merged pull request. Remaining gaps: 7.6 |
| M-02 | Medium | Whoever sent a settlement transaction could stop the API from ever recording it, by adding a one-unit token transfer to the same transaction. Amounts were inferred from whole-transaction balance changes, which then did not add up. No funds at risk; the developer's reputation was never credited. | Confirmed: executed on a validator (balance change 97,500,001 against an expected 97,500,000) and reproduced through the API | **Fixed for transactions that call the program directly**, whatever else they carry: other programs' instructions and transfers (this finding) and further Taskra instructions (N-1, 7.5). **Open for a settlement invoked through another program**: detected and refused explicitly, never recorded (7.6) |
| M-03 | Medium | A writer with the API's database role could relink a wallet to another person's GitHub account; rule R5 then accepted that person's pull requests for the attacker's wallet. | Confirmed from the grants | **Mitigated**: R12 requires the pull request's own commit to name the wallet, so a forged link alone is not enough (tested). The API role can still write the link table; see 7.3 |
| M-04 | Medium | The sign-in message can be relayed by a look-alike site (F-03). | Known | **Open**; see 7.3 |
| L-01 | Low | `work_duration` had no upper bound. A value near `i64::MAX` gave a task that could be accepted but never submitted, cancelled or refunded: escrow locked for good. The documented claim that escrow can never be locked was false. Self-inflicted by the client. | Confirmed: executed on a validator | **Fixed** (program bounds, D24) |
| L-02 | Low | A wrong pull-request number, once registered, could not be corrected. After the work deadline the developer could not resubmit either. | Confirmed from the code | **Fixed** (correctable until verified). The first version of this fix introduced N-2, fixed in 7.5 |
| L-03 | Low | R6 ("merged by someone else") is satisfied by a merge bot or a second account. | Suspected | Open |
| L-04 | Low | R7 and R8 compare GitHub's clock with the chain's. | Suspected | Open |
| L-05 | Low | The `Secure` cookie flag and the "no attester key in the API" guard depended on `NODE_ENV` being `production`. | Confirmed from the code | **Fixed** (derived from `WEB_ORIGIN`; the API refuses unsafe combinations) |
| L-06 | Low | Rate limits are per socket address (F-05). | Known | Open |
| L-07 | Low | Settlement discovery reads the 25 newest finalized signatures of a task account; junk transactions can push an unreported outcome out of that window until someone reports it. | Confirmed from the code; not executed | Open |
| L-08 | Low | A GitHub account cannot be unlinked; a lost wallet strands it. | Confirmed from the code | Open |
| L-09 | Low | The API's database role can insert settlement records, so a compromised API can forge reputation. | Confirmed from the grants | **Open**; see 7.3 |
| L-10 | Low | The OAuth state cookie could be planted from a sibling subdomain. | Suspected | Open |
| — | Info | One-step `rotate_keys`; `.`/`..` allowed as repository name segments; no Content-Security-Policy; "append-only" holds against the service roles, not the table owner; a frozen token account can block an exit; the program emits no events. | — | Open |

No way to move escrowed funds without authorization was found: eight
unauthorized actions were attempted against the program on a validator
(wrong signer for cancel, submit, attest and approve; a third-party payout
destination; a non-treasury fee account; resolving a task that was not
disputed; the attester key used to approve) and each was refused with the
escrow untouched. That is a statement about what was tried.

### 7.2 What the fixes are, and what tests them

| Fix | Where | Regression tests | Kind of test |
|---|---|---|---|
| L-01 | `programs/taskra/src/constants.rs`, `instructions/create.rs`, `instructions/platform.rs`; `packages/sdk/src/idl.ts`; `apps/api/src/tasks/routes.ts` | `programs/taskra/tests/duration_bounds.rs` (8 tests): the exact locking value is refused; every exit is walked at the maximum bounds. `tasks.test.ts`: the API refuses durations above the bound | Executes the real program (LiteSVM) |
| M-01 | `apps/attester/src/rules.ts`, `github.ts`, `worker.ts`; `packages/sdk/src/hashes.ts`; `apps/web/src/components/TaskActions.tsx` | `rules.test.ts`, `worker.test.ts`: an unrelated merged pull request that passes R1–R9 is REJECTED and nothing is signed; wrong task, two tasks, wrong wallet, second wallet, one pull request for two tasks. `pnpm e2e` scenario H on a validator | Unit, worker with a real database, and end to end. GitHub is a stand-in in all three |
| M-02 | `apps/api/src/chain/parse.ts`, `chain/reader.ts`, `tasks/reconcile.ts` | `tasks.test.ts` "settlement transactions composed with other instructions" (14 tests) through the HTTP reconciliation path, with reputation credited once; `chain.test.ts`. `pnpm e2e` scenario A sends the composed transaction to a real validator | Reconciliation path with a fake chain; and end to end with the real one |
| M-03 | Same as M-01 | `worker.test.ts`: with the link rewritten to the attacker's wallet, the author's pull request is REJECTED on R12 | Worker with a real database |
| L-02 | `apps/api/migrations/1760100000000_evidence-correction.sql`, `apps/api/src/tasks/routes.ts` | `tasks.test.ts`: correction before verification; `409 EVIDENCE_LOCKED` after. `db.test.ts`: the trigger and the column grant | API and PostgreSQL |
| L-05 | `apps/api/src/config.ts`, `auth/routes.ts`, `github/routes.ts` | `app.test.ts`: non-https deployed origin refused; attester key refused on a deployed origin for every `NODE_ENV`. `auth.test.ts`: cookie is `Secure` on https with `NODE_ENV=test` | Configuration and HTTP |

`scripts/mutation-check.sh` now seeds 10 defects (two for the bounds) and
`scripts/mutation-check-services.sh` 39 (twenty-three for the fixes in 7.2,
7.5, 7.7 and 7.8). Run them to see whether the suites still catch each one; the last
recorded run is in 7.7.

### 7.3 Deliberately not changed

| Item | Why it was left | What a real fix needs |
|---|---|---|
| **Dispute default** (rejected, verified work is paid when the authority is silent) | Changing it is a protocol decision, and the alternative is worse in a different way. Analysis in `13-DECISIONS.md` §17.3 | The owner's decision; then `expire_dispute` and D6 |
| **M-04** sign-in relay | The message already names the domain; closing the gap needs the wallet to enforce the domain (Sign-In With Solana, `solana:signIn`). That changes the wallet contract of the web app and cannot be tested here without real wallets | Implement `solana:signIn` with a fallback policy, and test with real wallet extensions |
| **L-09** API can insert settlements | The API's reconciler is the only writer of settlements. Taking the privilege away means moving reconciliation into another process with its own database login and RPC access: a new service, not a grant change. A grant-only change would be cosmetic | A separate indexer process, or deriving reputation from the chain on demand |
| **M-03** link table grant | The OAuth callback must write the link. Wallet-signed links would protect an honest wallet from being relinked, but not the collusion case, which R12 now covers | Wallet-signed link records verified by the attester, if relinking of honest wallets is to be prevented as well |

### 7.4 Residual, restated

- A verified pull request is a declared, merged pull request. It is not a
  judgement that the acceptance criteria are met (L7).
- The escrow-liveness claim holds only within the conditions listed in
  `13-DECISIONS.md` §2.4.
- Everything in §5 and §6 above still applies, including: no independent audit.

### 7.5 Third pass: adversarial review of the remediation

The uncommitted remediation was reviewed adversarially before being committed,
again by its authors, with probes run in a throwaway copy. Three findings:

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| N-1 | Medium | The impact of M-02 by another route. The API refused every transaction that carried more than one top-level Taskra instruction, and did not see a Taskra instruction that another program invoked. Whoever sends a settlement (the client for `approve_task`; anyone for `expire_review` and `expire_dispute`) could add a second Taskra instruction, or call through a wrapper program, and the settlement was never recorded. A transaction that settled two tasks could be recorded for one of them at most. | Confirmed: reproduced through the API's reconciliation path with constructed transactions. The several-instruction case was then executed on a local validator (`pnpm e2e`, scenario I). The wrapper case was only constructed | **Fixed for several instructions.** Each task's outcome is read from its own top-level instruction and that instruction's own escrow transfers; a transaction is recorded once per task it concerns. **Wrapper calls are not supported**: detected, refused with a logged reason, nothing recorded. Open, 7.6 |
| N-2 | Medium | Introduced by the L-02 fix. The attestation service reads the registered pull-request number, asks GitHub, then records its verdict. A correction that committed in between left a VERIFIED result and an attestation for a number that was no longer the registered one. The task page then showed VERIFIED beside a pull request that had never been verified, and the correction could not be undone. Only the developer can do this; nothing on-chain changes. | Confirmed: executed against PostgreSQL with the real roles | **Fixed, after a second attempt.** Inserting a VERIFIED result rewrites the submission row and is refused unless it is for the number registered at that moment; the correction is refused once a VERIFIED result exists. Whichever commits first, the other fails (`13-DECISIONS.md` §17.5). The version first recorded here as Fixed only locked the row and could be passed (7.7, O-1) |
| N-3 | Low | The program sends the whole escrow balance to the paid party, so tokens deposited into an escrow come back out with the principal. The API recorded what was transferred. A developer could deposit any sum in the settling transaction, receive it back, and have it recorded as earnings: a 100 USDC task gave "total earned" 1,000,097.50 USDC. | Confirmed through the API. The sweep is program behaviour (`programs/taskra/tests/lifecycle.rs`) and was executed on a validator in scenario I | **Fixed.** A settlement record is the task's own amount and fee, divided as the program divides them. The transfers are checked as evidence that this happened; they are not the source of the numbers (`13-DECISIONS.md` §17.4) |

| Fix | Where | Regression tests | Kind of test |
|---|---|---|---|
| N-1 | `apps/api/src/chain/parse.ts` (`taskInstructions`, `findTaskInstruction`, `outcomeInvokedByAnotherProgram`), `tasks/reconcile.ts`, `migrations/1760200000000_transactions-per-task.sql` | `tasks.test.ts` "settlement transactions with several Taskra instructions": a settlement beside the creation of another task; one transaction settling two tasks under concurrent reads and reports; transfers listed under the other task's instruction; two outcome instructions for one task; a failed transaction carrying the outcome instruction; missing inner instructions; the wrapper call. `chain.test.ts`; `db.test.ts`. `pnpm e2e` scenario I | Reconciliation path with constructed transactions; PostgreSQL; and one real transaction on a local validator that settles two tasks |
| N-2 | `apps/api/migrations/1760300000000_verified-result-matches-registration.sql`, `apps/attester/src/worker.ts`, `apps/api/src/tasks/routes.ts`, `tasks/view.ts` | `db.test.ts` "a VERIFIED result and a correction of the registration": both orders with two real connections, each observed waiting on the other's lock. `worker.test.ts`: the correction lands while the service is asking GitHub; nothing is recorded or signed for the old number, and the task recovers. `tasks.test.ts`: the API answers `409 EVIDENCE_LOCKED` when it loses the race | PostgreSQL with the real roles; the worker with a real database; HTTP |
| N-3 | `apps/api/src/tasks/reconcile.ts` (`observedAmounts`) | `tasks.test.ts`: a 100 USDC task with a 1,000,000 USDC deposit records 97.50 earned and reputation 97.50; a refund with a deposit records the task amount. `chain.test.ts`: every fee rate from 0 to 100%, with and without a deposit. `pnpm e2e` scenario I makes the same deposit on a validator | Unit; reconciliation path; and end to end with real token transfers |

Three assertions that existed before this pass described the defective
behaviour and were changed, not removed: the database test that inserted a
VERIFIED result for a number other than the registered one; the two tests that
expected a swept deposit to be recorded as the developer's amount; and the
check that a transaction with two Taskra instructions is refused, which now
applies to two instructions for the same task only. A signature reported for a
task it carries nothing for is still refused, now from the chain (`422`) and no
longer from a database lookup (`409`).

### 7.6 What is still open after the third pass

Everything below is known and not fixed. None of it is covered by a claim
elsewhere in this repository.

| Area | What remains | Basis |
|---|---|---|
| Whose pull request it is | Only the account that opened the pull request is checked (R5), against a link the API's database role can write. The author of the commits is not authenticated, and anyone with push access to the pull request's branch can write its head commit, including a maintainer when edits by maintainers are allowed. The M-03 mitigation therefore fails against an attacker who can both rewrite the link and push to the victim's branch | From the code |
| What the task lines prove | A declaration by the developer, fixed at merge. Not that the work meets the acceptance criteria (L7) | By design |
| Head commit only | The lines are read from the head commit alone. If a maintainer updates the branch or commits a suggestion before merging, the head commit no longer carries them and honest work cannot be verified; after the work deadline it cannot be resubmitted either. It then depends on the client or on a dispute | Reasoned; not run against GitHub |
| Base branch | R2 checks the repository, not the branch. A pull request merged into any branch by any other account with write access counts, which sidesteps protection of the default branch | From the code; not run against GitHub |
| After the merge | A merged pull request's head cannot change, but a later revert is not observed | By design |
| Task identity in the attestation service | Closed in 7.7 (O-2) | — |
| Shared database credentials | The two database roles separate the services only when each connects with its own login (`04-DATABASE-SPEC.md` §6). With one shared login a compromised API can leave its role, insert a VERIFIED result and an attestation record, and the attestation service will sign it: it re-verifies before recording a result, not again before signing. Since 7.7 (O-4) the API refuses such a login on a deployment; the attestation service does not check its own, and still signs for the records it finds | Executed against PostgreSQL (7.7) |
| Settlements through another program | Detected and refused; the settlement and its reputation are never recorded. Whoever sends a settlement can choose this route, at the cost of deploying a program. Supporting it needs the nesting depth of inner instructions, which the current RPC client does not expose, and a wrapper program to test against | Constructed transactions only |
| M-04, L-09 | Unchanged (7.3) | — |
| L-03, L-04, L-06, L-08, informational items | Unchanged (7.1) | — |
| L-07, L-10 | See 7.7 | — |
| Liveness | Three exits need the client's own signature, and a program upgrade does not re-check tasks or a platform created earlier (`13-DECISIONS.md` §2.4, §17.1) | From the code |

What the tests do and do not exercise: GitHub is a stand-in in every test; no
browser wallet and no public cluster has been used; a settlement through
another program has only been constructed, never executed; the transactions of
scenarios A and I are real and ran on a local validator.

### 7.7 Fourth pass: review of the third-pass remediation

The uncommitted remediation (baseline `11458a0` on `security/remediation-1`)
was reviewed once more before being committed, with the instruction to distrust
the earlier passes. **Still a self-review**, by the same authors with the same
blind spots. It found that one fix recorded above as Fixed was not complete, and
executed an attack that 7.6 listed as "not executed".

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| O-1 | Medium (N-2 again) | The N-2 fix did not hold at every isolation level. The VERIFIED insert took a shared lock on the submission row; the correction's check for a VERIFIED result runs on the snapshot of the transaction making it. A correction in a `REPEATABLE READ` transaction that began before the VERIFIED result committed saw no lock and no result, and succeeded: a VERIFIED result and an attestation for a number that was no longer the registered one. The API never uses that isolation level, so this needs the API's database role, not just a developer session. | Confirmed: executed against PostgreSQL with the real roles; the new test failed with `changed` before the fix | **Fixed.** The VERIFIED insert rewrites the submission row. The same correction now fails with a serialization error (`13-DECISIONS.md` §17.5) |
| O-2 | Low | The attestation service took the task id from its database record and never compared it with the Task account at the record's address (open in 7.6). R11 compares the head commit with that id, so a record pointing at another task's account would have let a pull request made for one task verify another. | From the code. Needs a task record written with the API's database role before the genuine one exists; not executed end to end | **Fixed.** Precondition P1 compares the account's own `task_id` first; a mismatch is REJECTED without contacting GitHub |
| O-3 | Low | When a task was terminal at `finalized` and no examined transaction carried its outcome, reconciliation returned without recording or reporting anything. That is the L-07 case (junk transactions push the outcome out of the 25 newest signatures) and also a settlement through another program when the RPC node omits inner instructions. | Confirmed through the reconciliation path with 25 constructed transactions | **Fixed as to silence**: reported on every read, and recorded once anyone reports the signature. **L-07 itself is unchanged**: discovery is still bounded |
| O-4 | Medium | The two database roles separate nothing when the API connects with a login that can leave its role. `RESET ROLE` returns to the role the connection started with, so it is harmless; `SET ROLE NONE` is not. | Confirmed: executed in `db.test.ts`. A connection that had dropped to `taskra_api` under the migration login inserted a VERIFIED result and an attestation record. An existing test used `RESET ROLE` and so asserted less than it said; corrected | **Mitigated.** On a deployment the API refuses to start with a login that is a superuser, owns the schema's tables or is a member of `taskra_attester` (`13-DECISIONS.md` §17.6). Not covered: development; the attestation service's own login; whoever else holds that login |
| O-5 | Info | The rule that a settlement record divides the task amount and nothing else (N-3) existed only in the reconciler. | — | **Hardened**: `CHECK settlements_amounts_add_up`. Does not touch L-09 |
| L-10 | Low | The OAuth state cookie could be planted from a sibling subdomain, letting an attacker finish their own flow in a victim's browser and link the victim's GitHub account to the attacker's wallet. | Reasoned from the code; not executed in a browser | **Mitigated** over https: the cookie is named `__Host-taskra_oauth_state`, which a browser accepts only from the API's exact host. The enforcement is the browser's and has not been exercised in one. The session cookie has no such prefix |

| Fix | Where | Regression tests | Kind of test |
|---|---|---|---|
| O-1 | `apps/api/migrations/1760300000000_verified-result-matches-registration.sql` | `db.test.ts` "VERIFIED first, correction on a snapshot taken before it: still refused", beside the two orderings that wait on each other | PostgreSQL with the real roles and two connections |
| O-2 | `apps/attester/src/rules.ts`, `worker.ts` | `rules.test.ts`; `worker.test.ts` "REJECTED without contacting GitHub when the account at the stored address is another task" | Unit; worker with a real database and a stand-in chain |
| O-3 | `apps/api/src/tasks/reconcile.ts` | `tasks.test.ts` "whose signature is not among the newest for the task"; the wrapper case without inner instructions | Reconciliation path with constructed transactions |
| O-4 | `apps/api/src/startup.ts`, `main.ts`, `config.ts` | `db.test.ts` "a login that can leave the API role" (the forgery itself; the migration login refused; a login in both roles refused) and the dedicated login accepted | PostgreSQL with real logins. The refusal at process start was added and tested in 7.8 |
| O-5 | `apps/api/migrations/1760400000000_settlement-amounts-add-up.sql` | `db.test.ts` "refuse a settlement whose amounts do not add up to the task amount" | PostgreSQL |
| L-10 | `apps/api/src/github/routes.ts` | `github.test.ts` "on an https origin" | HTTP against the application; no browser |

#### Every earlier finding, as it stands after this pass

| Finding | Status | Note |
|---|---|---|
| M-01 evidence not bound to the task | **Narrowed, not fixed** | What verification establishes is listed below |
| M-02 / N-1 settlement suppressed by composing the transaction | **Fixed** for direct calls; **open** for a settlement through another program (detected and refused when inner instructions are reported; otherwise reported as not found) | Wrapper calls have only been constructed, never executed |
| M-03 link table writable by the API role | **Mitigated** (R12) | Fails against an attacker who can also push the pull request's head commit |
| M-04 sign-in relay | **Open** | No wallet-enforced domain binding |
| N-2 correction racing verification | **Fixed** (see O-1) | |
| N-3 swept deposit recorded as earnings | **Fixed**, and now a database constraint | |
| L-01 unbounded duration | **Fixed** | Program tests on LiteSVM |
| L-02 uncorrectable registration | **Fixed** | |
| L-03 merge bot or second account satisfies R6 | **Open** | |
| L-04 GitHub clock against chain clock (R7, R8) | **Open** | |
| L-05 guards depended on `NODE_ENV` | **Fixed** | |
| L-06 rate limits per socket address; unauthenticated reads cost RPC calls | **Open** | A terminal task with no settlement record costs up to 25 transaction reads per request |
| L-07 bounded settlement discovery | **Open**, no longer silent (O-3) | Recoverable by reporting the signature |
| L-08 no unlinking | **Open** | |
| L-09 API role can insert settlements | **Open** | A forged record must add up, and nothing more |
| L-10 state cookie planting | **Mitigated** | Browser-enforced; not exercised in a browser |
| One-step `rotate_keys` | **Accepted** | A mistyped authority is permanent. Disputes then end only by timeout, and the treasury can never be changed |
| Upgrade authority | **Accepted** | Fully trusted; an upgrade can change every rule |
| Exit liveness | **Accepted**, bounded | Every state has an exit that opens at a fixed time. Three need the client's signature. Paying the developer needs the treasury account and the developer's token account to exist and not be frozen |
| Reconciliation after a program upgrade | **Unresolved** | The API decodes with the IDL it was built with. A changed layout or instruction set makes accounts or outcomes undecodable; nothing is recorded, and since this pass that is reported |
| Dependency advisories | **Accepted** | `pnpm audit`: 6 (2 high, 4 moderate), unchanged; production dependencies of the running services: the 4 moderate ones, inside `@solana/web3.js` |

#### What GitHub verification establishes

| About | Established | Not established |
|---|---|---|
| Repository | The pull request targets the repository named in the terms the client funded (terms hash on-chain; R2), and that repository is older than the task (R3) | Who controls the repository. A client and a developer who control it together can satisfy every rule |
| Task | The Task account is the one the record names (P1), and the head commit's message names that task's id (R11) | That the change has anything to do with the task. The line is written by the developer |
| Pull request | Its number and head commit are the ones hashed on-chain by the developer's `submit_work` (R9) | — |
| Developer | The account that opened the pull request is the one linked to the developer's wallet in the database (R5), and the head commit names that wallet (R12) | That the link is genuine (the API's role can write it), or that this person wrote the work |
| Commit authorship | Nothing | Commit authors and signatures are not read. Anyone who can push to the branch writes the head commit |
| Head commit | Fixed by the hash; cannot change after `submit_work` without failing R9 | A maintainer's last-minute commit replaces the head and makes honest work unverifiable |
| Base branch | Nothing beyond the repository | Any branch counts |
| Merger | An account other than the author's merged it (R6) | That the merger is a maintainer, a human, or independent of the developer |
| Timing | GitHub's merge time lies between acceptance and the work deadline (R7, R8) | The two clocks are not the same clock |
| After the merge | Nothing | A revert or force-push after verification is not observed |

#### What was run for this pass

On the working tree described above, after the last code change, in WSL.
Dependencies were the ones already installed (`node_modules`, `target`); this
is **not** a clean-clone run.

| Check | Result |
|---|---|
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed |
| `pnpm test` (SDK, shared, API, attestation service, web) | Passed |
| `pnpm anchor:fmt`, `pnpm anchor:lint`, `pnpm anchor:build`, `cargo test --workspace` (LiteSVM, not a validator) | Passed: 119 program tests |
| `scripts/test-deploy-guards.sh` | Passed: 11 checks |
| `pnpm e2e` (local validator, real program, real PostgreSQL with one login per service, stand-in GitHub) | Passed: 189 checks, scenarios A to I, run again after the last code change |
| `pnpm sdk:validator-loop` (local validator) | Passed. Run before the last change of this pass, which touched only the API's OAuth cookie |
| `scripts/mutation-check-services.sh`, in a throwaway copy of the tree with the changes committed there | All 36 caught |
| `scripts/mutation-check.sh`, same copy | All 10 caught |
| `pnpm audit` | 6 advisories (2 high, 4 moderate), as in F-08 |
| `pnpm anchor:test` | Passed. It builds the program and runs the same 119 tests on LiteSVM (`skip_local_validator`); it does not start a validator |
| `pnpm db:up` (docker-compose PostgreSQL) | **Could not run**: no Docker in the environment. The suites use an ephemeral PostgreSQL |
| Devnet, a browser wallet, real GitHub OAuth and API | **Not exercised** |

### 7.8 Fifth pass: the startup check, the boundaries restated, a fresh clone

A last pass before committing, by the same authors. **Not an independent
review.** It changed code in one place only, the API's check of its own
database login (O-4), and otherwise verified.

#### The startup check

The check stays a refusal. It was not made a warning for the sake of a demo.
Three things were tightened:

- **What is refused.** Besides a superuser, an owner of the schema's tables and
  a member of `taskra_attester`, the API now refuses a login that may create
  roles, and any login for which some role it is or can become may insert a
  verification result or insert or update an attestation record. The last one
  does not depend on names: it catches a direct grant and `pg_write_all_data`.
- **What counts as a deployment.** An `API_HOST` that other machines can reach
  now counts, beside a non-loopback web origin and `NODE_ENV=production`. Before,
  a development `NODE_ENV` with a loopback web origin skipped the check even
  when the API listened on every interface.
- **Failing closed.** A login that cannot be inspected (no connection, no
  schema) stops the API the same way.

`startup.test.ts` starts the real process from `main.ts` against PostgreSQL:

| Case | Observed |
|---|---|
| Superuser login, deployed | Exit 1, "is a superuser", never listened |
| Non-superuser login that owns `verification_results`, deployed | Exit 1, "owns tables of the schema" |
| Login that is a member of `taskra_api` and `taskra_attester`, deployed | Exit 1, "is a member of taskra_attester" |
| Database unreachable, deployed | Exit 1 |
| Login that is a member of `taskra_api` only, deployed | Starts; `GET /health` answers 200 |
| Superuser login, loopback web origin, `NODE_ENV=production` | Exit 1 |
| Superuser login, non-loopback web origin, `NODE_ENV` `development` and `test` | Exit 1 |
| Superuser login, loopback web origin, development, `API_HOST=0.0.0.0` | Exit 1 |
| Superuser login, loopback web origin, development, loopback `API_HOST` | Starts: the one exemption, a developer's machine |

Without a process, against PostgreSQL: a role administrator, a direct `INSERT`
grant on `verification_results`, a direct `UPDATE` grant on `attestations`,
membership of `pg_write_all_data`, and membership of `taskra_attester` through
an intermediate role are each refused; a member of `taskra_api` only is
accepted.

Not tested: a login whose privileges are raised after the API has started; a
PostgreSQL version other than 17; a managed service whose default login has
attributes these checks do not look at. The attestation service still does not
check its own login.

#### The boundaries, restated

For each: what must hold, what enforces it, and what the evidence is. "Enforced
by the database" means by triggers and constraints that the two service roles
cannot change; the table owner and a superuser can.

| Item | What must hold | Enforced by | Evidence | Not covered |
|---|---|---|---|---|
| N-2 | A VERIFIED result, and so an attestation, names the pull-request number registered for its submission, at every moment after commit | The database: the VERIFIED insert rewrites the submission row; the correction trigger refuses once a VERIFIED result exists | `db.test.ts`: both orders with two connections, each seen waiting; the `REPEATABLE READ` case. `worker.test.ts`, `tasks.test.ts`. Mutations 22, 27, 28, 31 | The table owner |
| N-3 | A settlement record never states more than the task's amount, divided as the program divides it | The reconciler computes it from the finalized Task account; the database refuses a record that does not add up | `tasks.test.ts`, `chain.test.ts`, `db.test.ts`; e2e I on a validator with a real deposit. Mutations 18, 19, 29, 34 | That a record that adds up is true (L-09). The split between fee and developer is not checked by the database |
| O-2 | The task id that rule R11 compares a commit with is the id of the Task account that will be attested | The attestation service, before contacting GitHub; the account's id is written by the program from its address seeds | `rules.test.ts`, `worker.test.ts`. Mutation 32. e2e runs with real accounts | Only the id is compared; the client wallet in the database row is not |
| O-4 | Whoever controls the API process cannot write a verification result or an attestation record | PostgreSQL privileges of the API's login, and the API's refusal to run on a deployment with a login that has more | `db.test.ts` executes the forgery with a shared login; `startup.test.ts` above. Mutations 35, 37, 38, 39 | Development; the attestation service's login; privileges changed after startup. **Mitigated, not closed** |
| L-09 | A settlement record corresponds to a settlement on-chain | **Nothing but the API's own code.** The API's role may insert `onchain_transactions` and `settlements`, so whoever controls the API can insert a record for a task that never settled, and reputation is a view over those records | `db.test.ts` inserts settlements with the API role. The constraint limits a forged record to one that adds up | **Open.** Closing it needs a separate process with its own login for reconciliation, or reputation derived from the chain on request |
| M-01 | A verified pull request was made for this task by this developer | **Only partly enforceable.** R11 and R12 require the head commit to name the task and the wallet; the commit is whatever the pusher wrote | `rules.test.ts`, `worker.test.ts`, e2e H, all against a stand-in GitHub | **Narrowed, not fixed.** See the table in 7.7: authorship, base branch, the merger's independence and later reverts are not established |
| N-1 | A settlement is recorded from the instruction that made it, or not at all | The reconciler reads only top-level Taskra instructions of the task and that instruction's own transfers; anything else records nothing and is reported | `tasks.test.ts`, `chain.test.ts`; e2e A and I on a validator. Mutations 25, 26, 33 | **A settlement invoked through another program is never recorded.** It is recognised when the RPC node reports inner instructions and reported as "not found" when it does not. Wrapper calls were constructed, never executed |

#### Fresh clone

`git clone` of the repository into a new directory at `11458a0`, with the
candidate applied there as a patch plus its untracked files and committed in
the clone only. All 218 source files were then compared with the working tree
and were identical. The clone had no `node_modules`, no `target`, no `dist`, no
`.env` and no program keypair. The machine's toolchains were used, and so were
its package and crate download caches (`pnpm` reported 380 packages reused and
none downloaded); nothing built was carried over. The results text of this
section was written afterwards and is the only difference from what was run.

| Command, in the clone | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed |
| `pnpm test` | Passed: 639 tests (SDK 216, shared 52, API 193, attestation service 115, web 63). The database concurrency and startup tests are in the API suite and ran against an ephemeral PostgreSQL 17 |
| `pnpm anchor:fmt`, `pnpm anchor:lint`, `pnpm anchor:build` | Passed; 508 crates compiled from nothing; the tree was unchanged afterwards |
| `pnpm anchor:test` | Passed: 119 program tests on LiteSVM, not a validator |
| `pnpm e2e` | Passed: 189 checks, scenarios A to I, on a local validator |
| `pnpm sdk:validator-loop` | Passed, on a local validator |
| `scripts/mutation-check-services.sh` | All 39 caught |
| `scripts/mutation-check.sh` | All 10 caught |
| `scripts/test-deploy-guards.sh` | **Blocked: 6 of 11 checks passed, 5 could not run.** They need the owner's program keypair, which is git-ignored and absent from any clone, as the script's header says. All 11 pass in the working tree that holds the keypair |
| `pnpm db:up` | **Could not run**: no Docker in the environment |
| Devnet, a browser wallet, real GitHub OAuth and API | **Not exercised** |
