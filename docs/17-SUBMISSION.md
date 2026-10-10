# Taskra — Hackathon Submission Pack

Working copy for the Colosseum submission. Everything stated as fact here is
backed by the repository at the commit named in §1. Anything not verified is
marked **not verified**.

> **The official submission requirements are not in this repository.** The
> deadline, required fields, video length limits, and whether a live deployment
> or public repository is mandatory must be read from the Colosseum dashboard.
> §2 lists exactly what to look up. Nothing below assumes an answer.

## 1. Verified state

| Item | State |
|---|---|
| Integration branch (the baseline) | `integration/phases-3-9` at `11458a0`. Everything in this pack that predates the security remediation describes this commit |
| Published branch | `publish/colosseum` at `e82eec5`, which a configured remote (`origin`) also carries. Its files are identical to `11458a0`. **It contains none of the security remediation** |
| Remediation branch (current work) | `security/remediation-1`, created from `11458a0`. The remediation described in `15-SECURITY-AUDIT.md` §7 exists there as **uncommitted changes in the working tree**: reviewed by its authors only, not committed, not pushed |
| Branch intended for publication | **Not decided.** Publishing the remediation means committing it and choosing where it goes (§9, item 5). Until then the published code has the defects §7 of the audit describes |
| `main` | The older Phase 2 commit (`a969203`) |
| Works on | A **local Solana validator** only |
| Devnet | **Not deployed.** The deploy script has been dry-run only |
| Mainnet | Not deployed. Not intended |
| Local stack over HTTP | Verified by script: validator + platform, API `/ready`, attestation service started, web app built with the local values and serving every route with status 200, CORS and the sign-in challenge correct for the web origin, no server secret anywhere in the web build |
| Browser + wallet extension | **Not verified** by anyone. The pages are served and configured; connecting a wallet, signing and the on-page flows have never been clicked through |
| Real GitHub OAuth and API | **Not verified**; automated runs use a fake GitHub |
| Security | Self-reviewed in five passes (`15-SECURITY-AUDIT.md`); each later pass found problems in the code or in the fixes of the one before. **No independent audit. Not for real funds** |
| Public repository | A remote named `origin` is configured and carries `publish/colosseum`. Whether that repository is public, and who can read it, was not checked from this machine |

Re-verify before submitting:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm anchor:test
pnpm e2e                 # about six minutes; ends "END-TO-END RUN PASSED: 189 checks"
```

## 2. What to read from the Colosseum dashboard

Fill this in first; it decides the order of everything else.

| Question | Answer |
|---|---|
| Exact deadline, with time zone | |
| Is a public GitHub repository required? By when must it be public? | |
| Pitch video: required? Maximum length? Hosting (YouTube/Loom/upload)? | |
| Technical demo video: required separately? Maximum length? | |
| Is a live app or a devnet/mainnet deployment **required**, or optional? | |
| Is a program address required in the form? | |
| Required text fields and their character limits (description, problem, solution, …) | |
| Team fields (names, roles, contacts, country) | |
| Track / category to select | |
| Business, go-to-market or traction fields | |
| Any rule about code written before the hackathon start date | |
| Any rule about AI-assisted development needing disclosure | |

## 3. Checklist, ordered by deadline risk

Items that need a person, an account or a recording come first: they cannot be
finished by code.

| # | Item | Owner | State |
|---|---|---|---|
| 1 | Read the dashboard and fill in §2 | You | Open |
| 2 | Decide: public repository? Create it and authorize the push (§9) | You | Open |
| 3 | Record the demo video (§7) | You | Open; script ready |
| 4 | Record the pitch video (§6) | You | Open; script ready |
| 5 | Decide on devnet (§10). Only if required or if time clearly allows | You | Open; not required to be true to the product |
| 6 | Run the interactive browser walkthrough once (§7 track B) | You | Open; **never run yet** |
| 7 | Paste the text fields (§4, §5, §8) into the form, within its limits | You | Drafted |
| 8 | Add a LICENSE if the repository goes public | You decide which | Open; none exists |
| 9 | Final check from a fresh clone of the public repository | Either | Open |

## 4. Project description

### One line

Taskra is a Solana escrow for small technical jobs where payment is released by
verifiable GitHub evidence instead of by trust.

### Short (about 60 words)

A client locks USDC in a Solana escrow for a defined task. A developer accepts,
does the work, and submits a pull request. Taskra checks that pull request
against fixed, public rules and records the result on-chain. The client
approves, or a review window expires, and the escrow pays the developer.
Every settlement becomes part of the developer's on-chain work record.

### Full

Strangers cannot easily transact around a small piece of technical work. The
client does not know whether the developer will deliver; the developer does not
know whether the client will pay. Marketplaces solve this by holding the money
and the reputation themselves.

Taskra replaces the intermediary with a program and a rule set:

1. **Escrow.** The client creates a task and funds it with USDC in one atomic
   transaction. The funds sit in a token account owned by a program-derived
   address; no wallet key, including Taskra's, can sign for it.
2. **Evidence.** The developer accepts and, before the work deadline, records
   the hash of a GitHub pull request on-chain. The hash commits to the
   repository, the pull-request number and its head commit.
3. **Verification.** An attestation service fetches the pull request from
   GitHub and checks eleven rules: it targets the repository named in the task,
   the repository pre-dates the task, it is merged, its author is the
   developer's linked GitHub identity, it was merged by someone else, it was
   merged inside the work window, its final commit names this task and the
   wallet to be paid, and the hash recomputed from GitHub's own data equals the
   hash on-chain. If all hold, it records an attestation
   on-chain. That attestation is the only thing its key can sign, and it can
   only start a review window — it cannot move funds.
4. **Settlement.** The client approves, or does nothing and the review window
   expires: the escrow pays the developer, less a 2.5% fee. If the client
   rejects, the task is disputed; a platform authority can decide either way,
   and if it does not, a permissionless fallback pays verified work and refunds
   unverified work.
5. **Record.** The task account is never closed. It is the permanent record
   that this wallet delivered this work for this amount.

Every non-terminal state has an exit that opens at a fixed time without the
other party's cooperation (durations are capped at 365 days on-chain; someone
must send the permissionless transaction).

**What is honest to claim:** Taskra verifies evidence against predefined
conditions. A merged pull request is evidence that a maintainer accepted the
work; it is not proof that the work is correct.

## 5. Technical differentiation

### What exists and is tested

| Capability | Where | Evidence |
|---|---|---|
| Atomic create-and-fund escrow in USDC, PDA-owned | `programs/taskra` | Program tests; e2e A |
| 14-instruction lifecycle with deadline-driven exits; double settlement impossible | `programs/taskra`, `13-DECISIONS.md` §2 | 119 program tests incl. randomized sequences; 10/10 program mutations caught |
| Evidence hash bound to repository, PR number and head commit; resubmission voids an earlier attestation | program, SDK | Published hash vectors asserted in Rust and TypeScript; e2e F |
| Attester that can sign exactly one instruction with no token accounts | `apps/attester/src/signer.ts` | `signer.test.ts`; fake cluster verifies the signature and instruction |
| Rule-by-rule, append-only verification audit trail (head SHA and merge commit SHA) | `apps/attester`, PostgreSQL | `worker.test.ts`, `db.test.ts` |
| GitHub outages can never become "verified" | `apps/attester` | `rules.test.ts`, `github.test.ts`; e2e E |
| API that never signs and derives every effect from its own chain read; `confirmed` is pending, only `finalized` is recorded | `apps/api` | `tasks.test.ts`; e2e A–C |
| Metadata bound to the chain by a terms hash recomputed by API, attester and browser | SDK `termsMatchTask` | e2e F (tampered metadata flagged) |
| Web app that reads task state from Solana itself and shows success only at finality | `apps/web` | `transaction.test.ts`, `actions.test.ts` (logic only; UI **not verified** in a browser) |
| Seeded-defect checks for program and services | `scripts/mutation-check*.sh` | See `15-SECURITY-AUDIT.md` for the last recorded run |

### How this differs from a task tracker or a payment app

- A task tracker records that someone *said* work was done. Taskra pays on
  evidence that a third party (a maintainer) merged it, under rules fixed before
  funding.
- A payment or simple escrow app needs one side to trust the other, or an
  operator to decide. In Taskra the operator's key cannot move funds on a
  normal task at all; it can only decide a *disputed* task, only between the two
  recorded parties, and only until a timeout after which the outcome is
  mechanical.
- The verifier is deliberately weak: its compromise can start review windows
  and nothing else. The trust it needs is documented, bounded and tested rather
  than assumed (`13-DECISIONS.md` §7.5).

### Not built (future, and not claimed)

- Reliability rewards or any token: deferred; "Reliable Contributor" is an
  off-chain label.
- AI agents as workers: a direction, not a feature. Nothing agent-specific
  exists.
- Evidence other than merged pull requests on public GitHub repositories.
- A keeper for expiries, an indexer, notifications, search.
- Any deployment.

## 6. Pitch script

Written for about three minutes at a normal pace. **Trim to the official
limit** once known: the bracketed sections can be cut first.

> **Problem (0:00).** "I need a Solana developer to fix a bug. I'll pay a
> hundred dollars." Simple — until you ask who goes first. If the client pays
> up front, the developer can vanish. If the developer works first, the client
> can. For a hundred-dollar job nobody is going to sign a contract. So today a
> platform holds the money, takes a cut, and owns your reputation.
>
> **Idea (0:30).** Taskra removes the question of who goes first. The client
> locks USDC in a Solana escrow that no one — not the client, not the
> developer, not us — holds a key to. The developer does the work in the open,
> as a GitHub pull request. And the rules for what counts as "done" are fixed
> before the money goes in.
>
> **How (1:00).** When the developer submits, they record a hash of their pull
> request on-chain. Our verifier fetches that pull request from GitHub and
> checks eleven rules — right repository, actually merged, merged by someone
> other than the author, inside the deadline, the hash matches, and the pull
> request's own final commit names this task and the wallet to pay. If they all
> hold it writes one attestation on-chain. That starts a review window. The
> client approves, or does nothing — and when the window ends, anyone can
> settle the task. The developer is paid; Taskra takes two and a half percent.
>
> **Why it holds up (1:45).** We designed for the unhappy paths. [The verifier's
> key can sign exactly one instruction, and that instruction touches no token
> account — steal it and you still cannot move a cent.] If the client rejects,
> the task is disputed, and if nobody resolves it, a timeout pays verified work
> and refunds unverified work. Every state has an exit with a deadline, so a
> task cannot simply hang on an absent party.
>
> **What is real (2:15).** This runs end to end today on a local validator:
> the program, an SDK, an API that never holds a key, the verifier, and a web
> app. One command runs nine scenarios and a hundred and eighty-nine checks
> against the real program. [We seed bugs into our own code and require the
> tests to catch each one — and our second self-review still found real
> problems, which we fixed and wrote up.] It is not deployed to devnet yet and
> it has not been audited; we would rather show you something true.
>
> **Where it goes (2:40).** Each settled task is a permanent, verifiable work
> record tied to a wallet. That is a reputation you carry with you, built from
> payments and merged code instead of star ratings. [The same rails — escrow,
> evidence, settlement — do not care whether the worker is a person or a
> program.] Taskra: verifiable work, programmable payment.

## 7. Demo script

Two tracks. **Track A is verified and can be recorded today.** Track B is the
better video but has never been run by anyone; do one full dry run before
recording, and fall back to A if anything misbehaves.

### Track A — terminal, verified (about 2–3 minutes after editing)

Setup: a terminal in `~/taskra`, font large enough to read.

| Time | Show | Say |
|---|---|---|
| 0:00 | `README.md` architecture diagram | The pieces: program, API that never signs, verifier with the only key, web app |
| 0:20 | Run `pnpm e2e` (cut the build wait) | One command starts a real validator, the real program, a database, the API and the verifier, and drives nine scenarios with test wallets. GitHub is the only thing replaced by a stand-in |
| 0:40 | Scenario A lines: `task is OPEN`, `task is SUBMITTED`, `verification is VERIFIED`, `every rule passed`, `task is UNDER_REVIEW` | Funded, accepted, evidence recorded on-chain, verified, attested |
| 1:10 | `fee observed on-chain: 2.50 USDC`, `developer observed on-chain: 97.50 USDC`, `developer balance grew by 97.50 USDC` | These amounts are read from the finalized transaction's token balances, not computed |
| 1:30 | Scenario B: `expire_review is refused before the review deadline`, then `API found the outcome transaction by itself` | The client disappears; after the window anyone settles; the API finds it without being told |
| 1:50 | Scenario E: `PENDING … while GitHub is unavailable`, `rejected because the pull request is not merged (R4)`, `client refunded in full` | An outage is never a verdict; unverified work ends in a refund |
| 2:10 | Scenario G: `the attester refuses to start with a key the platform does not name` and the final `END-TO-END RUN PASSED: 189 checks` | The services as real processes |
| 2:25 | `scripts/mutation-check-services.sh` result line, or `docs/15-SECURITY-AUDIT.md` §4 | We break our own code on purpose; all are caught. Self-reviewed, not audited |

State on camera or in a caption: **local validator, test wallets, fake GitHub in
the automated run.**

### Track B — browser, **not verified**

Follow `16-DEMO-RUNBOOK.md` §3 exactly. Minimum manual steps:

1. Start Docker Desktop (needed for `pnpm db:up`).
2. `scripts/localnet.sh`; copy `.localnet/env` into `.env`; `pnpm db:up && pnpm db:migrate`.
3. Start the API, the attestation service and the web app (three terminals).
4. A Wallet Standard browser wallet pointed at `http://127.0.0.1:8899`, with a
   client and a developer account; `scripts/localnet.sh fund <address> 1000` for each.
5. For the "Verified" step only: a GitHub OAuth app (callback
   `http://localhost:4000/api/v1/github/callback`), a public repository, and a
   second GitHub account to merge the pull request.

If step 5 is not possible in time, the lifecycle still completes: the client
may approve an unverified submission, and the page shows which rule failed.
Say so on camera; do not present it as verified.

Known risks for track B, since it is untested: whether the chosen wallet
accepts a local RPC endpoint and exposes `solana:signTransaction`; explorer
links for a local validator only resolve on the same machine.

### Never

No mocked screenshots, no edited transaction signatures, no devnet or mainnet
labels on local footage, no "audited".

## 8. Go-to-market

Stated as a plan. **There is no market validation, no users, no partners and no
revenue to report.**

| | |
|---|---|
| First users | Open-source maintainers and small crypto teams who already pay bounties for well-scoped fixes, and the contributors who take them |
| Their problem | Paying a stranger for a small fix means trusting them or a platform; bounty payouts are manual, slow and discretionary; contributors cannot prove a paid track record outside one platform |
| Why Taskra fits them first | Their work already ends in a merged pull request, which is exactly the evidence Taskra verifies. No behaviour change beyond funding an escrow |
| Adoption mechanism | Supply follows funded tasks. Start from the client side: a maintainer funds a task against their own repository and shares the link in the issue. The developer needs only a wallet and a GitHub account |
| First channel | Solana ecosystem repositories and developer communities, where both sides already hold wallets and USDC. One repository's backlog of labelled issues is enough to test the loop |
| Monetization | The 2.5% settlement fee enforced by the program. Nothing is charged on refunds or cancellations |
| What must be true | Clients respond within the review window (or accept auto-settlement); the verifier's rules match how maintainers actually merge; fees on small tasks exceed operating cost |
| Not claimed | Any demand figure, any customer, any comparison of fee levels with other platforms |

Later, and only as direction: other evidence types; reputation read by third
parties from the permanent task accounts; programmatic clients and workers.

## 9. Publishing the repository

Checked at the commit above:

- No `.env`, keypair, PEM or key file is tracked or appears anywhere in history
  (all refs). `.env.example` has blank values for every secret.
- No token, private-key block or 64-byte key array appears in any added line in
  history. The only connection strings are placeholders and test fixtures.
- `.gitignore` covers `.env*`, `*-keypair.json`, `/.localnet/`, `*.pem`, `*.key`.
- Local, untracked and ignored: `.env`, `.localnet/`, `target/deploy/taskra-keypair.json`.
  **Never add these.** The program keypair only fixes the program address; back
  it up privately if you intend to deploy to that address.

Before pushing, decide:

1. **Public or private.** If judges need access, public (or grant access as the
   dashboard instructs).
2. **Author email.** Every commit carries the committer's e-mail address; it
   becomes public with the repository.
3. **License.** There is none. Without one, others have no right to reuse the
   code. Choose one (or decide deliberately not to).
4. **Internal files.** `AGENTS.md` and `CLAUDE-BUILD-PROMPT.md` are tracked
   build instructions. Keep or remove as you prefer; they contain no secrets.
5. **Which branch judges see.** There are three candidates and they are not
   the same code (§1): `publish/colosseum` (already on the remote, without the
   remediation), `integration/phases-3-9` (the same files, the baseline), and
   `security/remediation-1` (the baseline plus the remediation, once that is
   committed). `main` is the Phase 2 commit. Decide which one is published and
   whether it becomes the default branch; nothing here decides it for you.

A remote named `origin` already exists in this checkout. To publish a branch
there, or to a repository you create (empty: no auto-generated README, license
or `.gitignore`), once you have decided which branch and authorize it:

  ```bash
  git remote -v                                   # check where `origin` points first
  git push -u origin <the branch you decided on>
  ```

- After pushing: clone fresh into a new directory and run the commands in §1.

## 10. Devnet

Not done, and not needed for anything claimed in this pack.

If the dashboard **requires** a deployed program, the minimum path is
`11-DEPLOYMENT-SPEC.md` ("Devnet program deployment" and "Devnet checklist").
Prerequisites and likely blockers:

| Need | Note |
|---|---|
| Devnet SOL for the upgrade authority (program deploy) and the attester | Faucet limits are the most likely delay |
| Four separate keys plus a treasury wallet and its USDC token account | The script refuses overlapping keys |
| Circle's devnet USDC mint address and devnet USDC for the client wallet | From Circle's documentation and faucet |
| The time windows are **permanent** once initialized | The script uses the devnet-demo profile (10/5/15 minutes) |
| A hosted API, attestation service, database and web app for a *live app* | A deployed program alone does not make the product usable; hosting is a separate, larger job |

A program deployed to devnet with nothing else is a weak claim. Prefer an
honest local demonstration over a rushed partial deployment, unless the rules
say otherwise. Never mainnet; never real funds.

## 11. Limitations to disclose

- Runs on a local validator only; nothing is deployed.
- The browser flow with a wallet extension has not been exercised by a person.
- Real GitHub (OAuth and API) has not been exercised; tests use a stand-in.
- Self-reviewed only. Open and accepted findings are in
  `15-SECURITY-AUDIT.md` §7.7: a relayable sign-in message, trust in the
  off-chain GitHub identity link, no Content-Security-Policy, proxy-dependent
  rate limits, an API database role that can insert settlement (reputation)
  records, and settlements made through another program, which are never
  recorded.
- "Verified" means: a pull request in the task's repository, opened by the
  account linked to the developer's wallet, merged by a different account
  inside the work window, whose head commit names the task and the wallet. The
  two lines in the commit are the developer's own declaration. It does not mean
  the work is correct, that the developer wrote it, or that the merger is
  independent of the developer.
- Not for real funds.
- `pnpm audit` reports 6 inherited transitive advisories (2 high, 4 moderate),
  unchanged since before the integration work; none is on a code path a running
  service uses.
- The program is upgradeable and its upgrade authority is fully trusted.
- Only merged pull requests on public GitHub repositories count as evidence.
- An attester key together with a colluding developer and an absent client can
  get unverified work paid after the review window (the documented residual
  risk of the design).
- No keeper: someone must send expiry transactions.
