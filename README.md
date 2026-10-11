# Taskra

Taskra is a Solana-native trust and settlement layer for verifiable technical
work: a client escrows USDC, a developer proves completed work with GitHub
evidence, and settlement builds the developer's reputation.

## Status

**Locally functional. Not deployed. Not audited.** These are separate levels:

| Level | State |
|---|---|
| Locally functional | Yes. Program, SDK, API, database, attestation service and web app work together on a local validator; `pnpm e2e` drives every journey end to end. |
| Devnet-tested | **No.** Nothing has been deployed to any public cluster. The deploy script has only been dry-run. |
| Production-deployed | **No.** |
| Security | Self-reviewed by its authors, in six passes ([docs/15-SECURITY-AUDIT.md](docs/15-SECURITY-AUDIT.md)); the second review found a fund-locking input, unbound evidence and a way to suppress settlement records, since fixed. **No independent audit.** Not for real funds. |

Not yet exercised by anyone: the web app in a real browser with a wallet
extension, and the GitHub steps against the real GitHub (the suites use a fake).
The exact remaining steps are in
[docs/11-DEPLOYMENT-SPEC.md](docs/11-DEPLOYMENT-SPEC.md) and
[docs/16-DEMO-RUNBOOK.md](docs/16-DEMO-RUNBOOK.md).

| Component | What it is |
|---|---|
| `programs/taskra` | Anchor program: escrow, attestation, settlement, disputes. 14 instructions. |
| `packages/sdk` | Addresses, unsigned instructions, decoders, hashes, timeline. Never signs. |
| `apps/api` | Fastify API: wallet sign-in, task metadata, transaction observation, reputation. Holds no key. |
| `apps/attester` | Attestation service: verifies GitHub evidence and signs `record_attestation`. The only process with a key. |
| `apps/web` | Next.js app: wallet connection, every task action, verification and settlement views. |
| `apps/e2e` | End-to-end harness and local-chain tooling. |
| `packages/shared` | Environment contract, database pool, test-database harness. |

## Architecture

```text
Browser (apps/web) ── wallet signs ──────────────► Solana: programs/taskra
   │   reads the Task account itself               ├─ Platform (config, keys, windows)
   │                                               ├─ Task (state; permanent work record)
   │ HTTPS, session cookie                         └─ Escrow token account (owned by the Task PDA)
   ▼                                                        ▲            ▲
API (apps/api) ── reads and verifies via its own RPC ───────┘            │ record_attestation
   │   no key; cannot sign                                               │ (the only thing it can sign)
   ▼                                                                     │
PostgreSQL ◄── verification jobs ── Attestation service (apps/attester) ─┘
 metadata, audit trail,                    │ reads pull requests
 observations                              ▼
                                         GitHub
```

- **Solana is authoritative** for escrow, task state, deadlines, fees and
  settlement. The database caches what was read, tagged with its commitment.
- **The API never signs** and never moves funds. It receives the signature of a
  transaction the user's wallet already sent, fetches that transaction itself,
  and derives its effect from the chain.
- **`confirmed` is progress; `finalized` is fact.** A settlement is recorded
  only from a finalized transaction and a finalized Task account.
- **The attester key lives in one process** with no network listener. The API
  can only queue "look at this submission"; the service re-derives every fact
  from the finalized Task account and from GitHub before signing, and what it
  signs can only start a review window, never move funds.

Boundaries: [docs/14-API-CONTRACT.md](docs/14-API-CONTRACT.md). Lifecycle,
accounts, fees, disputes and the threat model:
[docs/13-DECISIONS.md](docs/13-DECISIONS.md), which wins over every other
document.

## Task lifecycle

```text
DRAFT (database only)
  │ create_and_fund_task               client
OPEN ───── cancel_task ──────────────────────────► CANCELLED (full refund)
  │ accept_task                        developer
ACCEPTED ─ refund_expired (after work deadline) ─► REFUNDED
  │ submit_work                        developer
SUBMITTED ─ refund_expired (never verified) ─────► REFUNDED
  │   └──── open_developer_dispute ──► DISPUTED
  │ record_attestation                 attester (VERIFIED evidence only)
UNDER_REVIEW ─ approve_task / expire_review ─────► SETTLED (developer paid, 2.5% fee)
  │ reject_task                        client
DISPUTED ─ resolve_dispute (authority) or expire_dispute (anyone, after timeout)
             ├─ verified work ─► SETTLED
             └─ otherwise ─────► REFUNDED
```

Every non-terminal state has an exit that opens by a fixed time with no action
from the other party. That is true within stated conditions, not unconditionally:
durations are capped at 365 days by the program, someone has to send the
permissionless instruction, and a token account frozen by the mint's issuer can
still block a payout (`13-DECISIONS.md` §2.4).

## Local development

Requirements: Ubuntu on WSL (repository at `~/taskra`, not under `/mnt/c`), the
pinned toolchain below, and Docker for the development database.

```bash
pnpm install
scripts/localnet.sh                    # terminal 1: validator + program + test USDC; leave running
cp .env.example .env                   # set POSTGRES_PASSWORD and DATABASE_URL, then paste .localnet/env
pnpm db:up && pnpm db:migrate
pnpm --filter @taskra/api dev          # terminal 2: http://localhost:4000
pnpm --filter @taskra/attester dev     # terminal 3
pnpm --filter @taskra/web dev          # terminal 4: http://localhost:3000
scripts/localnet.sh fund <wallet> 1000 # test SOL and test USDC for a wallet
```

The full walkthrough, including wallet and GitHub setup, is
[docs/16-DEMO-RUNBOOK.md](docs/16-DEMO-RUNBOOK.md). Environment variables and
their `PUBLIC` / `SERVER_ONLY` / `SECRET` labels:
[docs/10-ENVIRONMENT-SPEC.md](docs/10-ENVIRONMENT-SPEC.md).

## Testing

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Unit and integration suites of every package. The API and attester suites run against a real PostgreSQL started for the run. | Node only |
| `pnpm anchor:test` | Program tests on LiteSVM: every transition, authorization, exclusivity, randomized sequences | Rust, Anchor |
| `pnpm sdk:validator-loop` | The SDK against a real `solana-test-validator` | Solana CLI |
| `pnpm e2e` | The whole system against a local validator: nine scenarios, about seven minutes | Solana CLI |
| `scripts/mutation-check.sh` | Ten seeded defects in the program; all must be caught | Clean tree |
| `scripts/mutation-check-services.sh` | Forty-two seeded defects in the API, attester and web logic; all must be caught | Clean tree |
| `scripts/test-deploy-guards.sh` | The devnet deploy script refuses unsafe configurations; dry run only | The owner's program keypair (git-ignored; not available in a fresh clone) |

Everything in this table except the last row runs from a fresh clone: the
local-validator scripts take the program address from the built IDL and need no
keypair.

The test database is an ephemeral PostgreSQL 17.10 from the `embedded-postgres`
package. To use another server (for example the docker-compose one, 17.11), set
`TASKRA_TEST_DATABASE_URL` to an admin connection string; only throwaway
databases are created on it. What each suite covers:
[docs/09-TESTING-SPEC.md](docs/09-TESTING-SPEC.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm lint` | ESLint over the workspace |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm build` | Build every package |
| `pnpm db:up` / `pnpm db:down` | Start / stop local PostgreSQL (Docker) |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm --filter @taskra/api db:migrate:create <name>` | Create a SQL migration |
| `pnpm anchor:build` / `pnpm anchor:fmt` / `pnpm anchor:lint` | Build / `cargo fmt --check` / `cargo clippy -D warnings` |
| `pnpm sdk:idl` | Regenerate the SDK's IDL module after `anchor build` |
| `scripts/localnet.sh` | Local validator with the program and an initialized platform |
| `scripts/deploy-devnet.sh --dry-run` | Preview the devnet deployment; the owner runs the real one |

## Using the SDK

```ts
import { createTaskraConfig, createAndFundTask, buildUnsignedTransaction } from '@taskra/sdk';

const config = createTaskraConfig({ cluster: 'devnet', usdcMint }); // the mint is always supplied
const instruction = createAndFundTask(config, { client, taskId, amount, workDuration, termsHash });
const transaction = buildUnsignedTransaction({ feePayer: client, recentBlockhash, instructions: [instruction] });
// A wallet signs it. The SDK cannot.
```

See [packages/sdk/README.md](packages/sdk/README.md).

## Specification pack

Read [AGENTS.md](AGENTS.md) and [docs/](docs/) before changing architecture.

| Document | Subject |
|---|---|
| [13-DECISIONS](docs/13-DECISIONS.md) | **Authoritative.** Lifecycle, accounts, fees, disputes, evidence rules, threat model, engineering choices |
| [14-API-CONTRACT](docs/14-API-CONTRACT.md) | Who is responsible for what |
| [04-DATABASE-SPEC](docs/04-DATABASE-SPEC.md) | Schema, authority, roles, idempotency |
| [05-API-SPEC](docs/05-API-SPEC.md) | Endpoints, authentication, errors |
| [06-GITHUB-VERIFICATION-SPEC](docs/06-GITHUB-VERIFICATION-SPEC.md) | Verification rules and attester security |
| [07-SECURITY-SPEC](docs/07-SECURITY-SPEC.md), [15-SECURITY-AUDIT](docs/15-SECURITY-AUDIT.md) | Requirements; self-review findings |
| [08-UI-UX-SPEC](docs/08-UI-UX-SPEC.md) | Routes, flows, transaction states |
| [09-TESTING-SPEC](docs/09-TESTING-SPEC.md) | What is tested and how |
| [10-ENVIRONMENT-SPEC](docs/10-ENVIRONMENT-SPEC.md), [11-DEPLOYMENT-SPEC](docs/11-DEPLOYMENT-SPEC.md) | Configuration; operations and deployment |
| [12-DEMO-SPEC](docs/12-DEMO-SPEC.md), [16-DEMO-RUNBOOK](docs/16-DEMO-RUNBOOK.md) | The demo and how to run it |
| [01-PRODUCT-SPEC](docs/01-PRODUCT-SPEC.md) | Product; amended passages are marked "(amended)" |

## Toolchain versions

Pinned; never "latest". Rationale in `13-DECISIONS.md` §12.

| Tool | Version |
|---|---|
| Rust | 1.89.0 |
| Solana CLI (Agave) | 3.1.10 |
| Anchor CLI / AVM | 1.1.2 |
| Node.js | 24.18.1 |
| pnpm | 12.3.4 |
| PostgreSQL | 17.11 (Docker image `postgres:17.11-alpine3.24`) |

## Known limitations

- Not deployed and not independently audited (see Status).
- The program is upgradeable; its upgrade authority is fully trusted (L3).
- Accept-squatting and the junk-submission delay are accepted MVP limitations
  (L1, L4); neither can produce a payment.
- An attester key plus a colluding developer and an absent client can get
  unverified work paid after the review window (L2, the residual risk of the
  attestation design).
- Only public GitHub repositories and merged pull requests count as evidence.
  An unmerged pull request can never be verified (L6).
- A verified pull request names its task and payee in its final commit, but that
  is a declaration, not a judgement of the work. If the person who merges is not
  the client, the client must use the review window (L7).
- A rejected, verified delivery is paid if the platform authority does not
  resolve the dispute in time (`13-DECISIONS.md` §17.3).
- No keeper: expiry instructions are permissionless and someone must send them
  (the web app offers the button to anyone).
- Task lists come from a cache that is refreshed when a task is read or a
  transaction is reported; the task page itself always reads Solana.
- The platform authority resolves disputes from the web app with its wallet;
  there is no separate admin tool.
- Wallets that cannot sign arbitrary messages cannot sign in.
- Per-address rate limits assume the API sees real client addresses.

The numbered limitations are defined in `13-DECISIONS.md` §14; the rest in
[docs/15-SECURITY-AUDIT.md](docs/15-SECURITY-AUDIT.md).
