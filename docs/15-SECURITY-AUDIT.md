# Taskra — Security and Reliability Review

**This is a self-review by the people who wrote the code, not an independent
audit.** It records what was examined, what was found, what was fixed and what
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
| Escrow lifecycle, disputes, refunds | Enforced by the program; the services only observe. All paths exercised end to end | Phase 1 suites, e2e A–F |
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
