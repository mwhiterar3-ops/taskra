# Taskra — Demo Runbook

Two ways to demonstrate Taskra on one machine. Both use a local Solana
validator and real transactions executed by the real program; neither touches
devnet or mainnet.

| | What it shows | Needs |
|---|---|---|
| **A. Automated run** (`pnpm e2e`) | Every journey, including disputes and failures, with every check printed | The pinned toolchain only |
| **B. Interactive run** (browser + wallet) | The product as a user sees it | Docker (PostgreSQL), a browser wallet that can use a local RPC endpoint; a GitHub OAuth app for the verification step |

What has been verified: **A** runs green on the development machine (see the
results table in the README). **B**'s services were started and exercised by A
(scenario G starts the real API and attestation-service processes), but the
browser steps with a wallet extension have **not** been run by the authors of
this runbook; treat them as instructions, not as evidence.

## 1. Environment preparation

```bash
cd ~/taskra                      # in WSL; not under /mnt/c
nvm use                          # Node 24.18.1
pnpm install
```

Toolchain versions are in `13-DECISIONS.md` §12. `anchor --version` must say
1.1.2 and `solana --version` 3.1.10.

## 2. A — Automated demonstration

```bash
pnpm e2e
```

About six minutes. It builds the program, starts a throwaway validator, a
throwaway PostgreSQL, the API (over HTTP) and the attestation service, and
drives these scenarios with test wallets. GitHub is replaced by a fake inside
the harness, so no credentials are needed.

| Scenario | Expected observable outcome |
|---|---|
| A. Full lifecycle | `verification is VERIFIED`, `task is UNDER_REVIEW`, then `fee observed on-chain: 2.50 USDC`, `developer observed on-chain: 97.50 USDC`, `reputation: one settled task`; a second approval is `recorded as FAILED` |
| B. Review expiry | `expire_review is refused before the review deadline`; after the deadline `API found the outcome transaction by itself` with outcome `REVIEW_EXPIRED` |
| C. Cancellation and bad requests | Unauthorized cancel refused with `Unauthorized`; wrong-task and non-Taskra signatures refused; `client refunded in full`; an unfunded wallet's task `stays a draft` |
| D. Rejection and dispute | `task is DISPUTED`, the reason is shown, and after the timeout the outcome is `DISPUTE_EXPIRED_FOR_DEVELOPER` because the work was verified |
| E. Unverifiable evidence | PENDING during a simulated GitHub outage, then `rejected because the pull request is not merged (R4)`; developer dispute; outcome `DISPUTE_EXPIRED_FOR_CLIENT`, `client refunded in full` |
| F. Resubmission | `the earlier attestation no longer applies`; approving old evidence refused with `EvidenceMismatch`; replayed jobs send nothing; tampered metadata `flagged as unverified` |
| G. Real processes | `GET /ready` is ready; the attestation service refuses to start with a key the platform does not name |

The run ends with `END-TO-END RUN PASSED: <n> checks`. Any failed check stops it
with `CHECK FAILED: ...` and exit code 1. The time windows are a test profile
(10 s review, 5 s grace, 8 s dispute) so the deadline paths run in real time.

## 3. B — Interactive demonstration

### 3.1 Startup sequence

Terminal 1 — chain (leave running):

```bash
scripts/localnet.sh
```

It prints the program id and a new test USDC mint and writes `.localnet/env`.
The local platform uses the devnet-demo windows: review 10 min, verification
grace 5 min, dispute timeout 15 min.

Terminal 2 — configuration and database:

```bash
cp .env.example .env
# In .env: set POSTGRES_PASSWORD, and
#   DATABASE_URL=postgres://taskra:<that password>@127.0.0.1:5432/taskra
# then replace the matching lines with the ones in .localnet/env
pnpm db:up
pnpm db:migrate
```

Then one terminal each:

```bash
pnpm --filter @taskra/api dev          # http://localhost:4000  (GET /ready should be 200)
pnpm --filter @taskra/attester dev     # logs "attester started"
pnpm --filter @taskra/web dev          # http://localhost:3000
```

Restart all three whenever `scripts/localnet.sh` is restarted: the mint changes.

### 3.2 Wallet setup

1. Use a browser wallet that supports the Wallet Standard and a custom or local
   RPC endpoint, pointed at `http://127.0.0.1:8899`.
2. Create two accounts in it: a **client** and a **developer**. Use fresh
   accounts that hold nothing of value.
3. Fund both with test SOL and test USDC:

   ```bash
   scripts/localnet.sh fund <client address> 1000
   scripts/localnet.sh fund <developer address> 0
   ```

### 3.3 GitHub (needed only for the verification step)

1. Create a GitHub OAuth app with callback
   `http://localhost:4000/api/v1/github/callback`; put its id and secret in
   `.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; restart the API.
2. Have a public repository that existed before the demo, and a second GitHub
   account that can merge pull requests into it (rule R6 rejects a self-merge).

Without this, everything except "Verified" works: the client can still approve
an unverified submission, and the verification panel shows which rule failed.

### 3.4 A complete successful task lifecycle

| Step | Do | Expect |
|---|---|---|
| 1 | Client: connect wallet, **Sign in** | Wallet shows a message beginning `localhost:3000 wants you to sign in`; header shows "Signed in" |
| 2 | **Create task**: title, repository `owner/name`, criteria, reward `100`, hours | Redirect to the task page, state `DRAFT` |
| 3 | **Create task and fund 100.00 USDC** | Status: awaiting wallet → submitted → confirmed → **final**; state `OPEN`; Terms "match the on-chain hash" |
| 4 | Switch wallet to the developer, sign in, open **Profile** → **Connect GitHub** | "Connected as …" |
| 5 | Open the task → **Accept task** | State `ACCEPTED`; work deadline shown |
| 6 | On GitHub, open a pull request from the developer's account; have the other account merge it | — |
| 7 | **Submit evidence**: PR number → **Look up head commit** → **Record evidence on-chain** | State `SUBMITTED`; verification "Pending" |
| 8 | Wait about 30 s | Verification "Verified", rules R1–R9 ticked, head and merge commit shown, on-chain attestation `FINALIZED`; state `UNDER_REVIEW` |
| 9 | Switch to the client → **Approve and pay developer** | After finality: "Finalized: approved — Developer received 97.50 USDC · treasury 2.50 USDC", with a link to the transaction |
| 10 | Open the developer's profile | Tasks settled 1, total earned 97.50 USDC, the task under "Verified work" |

Explorer links for a local validator open `explorer.solana.com` with a custom
RPC URL; they work only in a browser on the same machine.

### 3.5 A failure scenario: rejection and dispute

Repeat steps 1–8 with a new task, then:

| Step | Do | Expect |
|---|---|---|
| 9 | Client: **Reject submission**, give a reason | State `DISPUTED`; the reason is shown; the dispute deadline (15 min) is shown |
| 10 | Wait past the dispute deadline; any wallet clicks **Close dispute: deadline passed** | The button says it "Pays the developer: the submission was verified"; outcome `DISPUTE EXPIRED FOR DEVELOPER`; developer receives 97.50 USDC |

Alternative without GitHub: submit evidence for a pull request that is not
merged. Verification stays "Not verified" (R4). The client's **Refund escrow**
button is disabled with the reason; the developer's **Open dispute** becomes
available only after the verification window, and if nobody resolves it the
fallback "Refunds the client".

### 3.6 Shutdown

Ctrl-C each terminal; `pnpm db:down` stops PostgreSQL (data stays in the
`taskra-pgdata` volume). Delete `.localnet/` to discard the local keys.

## 4. What the demo must not claim

- Not deployed: nothing here ran on devnet or mainnet.
- Not audited: `15-SECURITY-AUDIT.md` is a self-review.
- "Verified" means the pull request met rules R1–R9, not that the work is correct.
- "Reliable Contributor" is an off-chain aggregate; no on-chain reward exists.
- The local and devnet-demo time windows are minutes long and unsuitable for real funds.
