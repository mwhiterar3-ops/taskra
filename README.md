# Taskra

Taskra is a Solana-native trust and settlement layer for verifiable technical
work: a client escrows USDC, a developer proves completed work with GitHub
evidence, and settlement builds the developer's reputation.

## Status: Phase 2 complete (SDK)

| Area | State |
|---|---|
| pnpm workspace, strict TypeScript, ESLint, Prettier | Done |
| Typed environment loader with tests | Done |
| Web: minimal Next.js app (root page only) | Done |
| API: Node.js/TypeScript with `GET /health` | Done |
| Local PostgreSQL (docker-compose) and empty migration setup | Done |
| Anchor program: escrow, attestation, settlement, disputes | Done; tested on LiteSVM and a local validator; **not deployed to any public cluster** |
| SDK (`packages/sdk`): addresses, unsigned instructions, decoders, hashes, timeline | Done; see [packages/sdk/README.md](packages/sdk/README.md) |
| Database schema, API endpoints, GitHub verification, product UI | Not started |

The SDK never signs and never holds keys. `pnpm sdk:validator-loop` proves it
against a real `solana-test-validator`: it creates an SPL mint, initializes the
platform with a short-window test profile and runs approval, review expiry,
cancellation and both dispute-fallback branches, printing every signature and
balance. Layer boundaries for the next phases are in
[docs/14-API-CONTRACT.md](docs/14-API-CONTRACT.md).

The program has 14 instructions (docs/13-DECISIONS.md §3.7). Its tests live in
`programs/taskra/tests`:

| File | Covers |
|---|---|
| `lifecycle.rs` | Every transition on its intended path, with exact fund movements |
| `authorization.rs` | Wrong signers, wrong mints, wrong token accounts, third-party destinations, key separation |
| `exclusivity.rs` | Double settlement, races, deadline boundaries, mutual exclusion of outcome paths |
| `client_lock.rs` | Worst-case client-fund lock equals the documented formula, for three window profiles |
| `evidence.rs` | Hash test vectors; an attestation for one hash cannot settle another; an arbitrary hash never pays by itself |
| `randomized.rs` | Random instructions, signers and clock advances with invariants checked after every step |

The tests load `target/deploy/taskra.so`, so run `anchor build` first
(`pnpm anchor:test` does both).

`randomized.rs` always runs seed `0x7A5C2026` plus seeds `0..TASKRA_FUZZ_SEEDS`
(default 48) for `TASKRA_FUZZ_STEPS` steps each (default 60); set both higher for
a longer run. `scripts/mutation-check.sh` seeds eight defects into the program,
one at a time, and fails unless the suite catches every one (it needs a clean
working tree and takes several minutes).

## Specification pack

Read [AGENTS.md](AGENTS.md) and every file under [docs/](docs/) before changing
architecture. [docs/13-DECISIONS.md](docs/13-DECISIONS.md) is authoritative for
the task lifecycle, account model, fees, disputes and evidence rules; the other
specifications were amended to agree with it. The product specification is
[docs/01-PRODUCT-SPEC.md](docs/01-PRODUCT-SPEC.md); its amended passages are
marked "(amended)".

## Architecture

```text
Browser (apps/web, Next.js) ── wallet ── signed tx ──► Solana: programs/taskra (Anchor)
        │                                                ├─ Platform (config)
        │ HTTPS                                          ├─ Task (state; permanent work record)
        ▼                                                └─ Escrow token account (USDC, owned by the Task PDA)
API (apps/api, Node.js/TypeScript) ── reads and verifies via RPC ──► Solana
        ├─► PostgreSQL (metadata, evidence, verification results, cached reputation)
        └─► GitHub (OAuth identity, pull-request checks)

packages/sdk     PDA derivation, unsigned instruction builders, account decoding, hashes
packages/shared  Typed environment contract shared by web and API
```

Solana is authoritative for escrow, task state and settlement. PostgreSQL is
authoritative for metadata and verification records, and only mirrors financial
state after reading it from the chain. The API never holds user keys or funds.

## Layout

```text
apps/web          Next.js web application
apps/api          Node.js/TypeScript API and database migrations
packages/sdk      Solana SDK (never signs; see its README)
scripts/          Validator loop, mutation check, devnet deploy
packages/shared   Shared environment loader
programs/taskra   Anchor program
docs/             Specification pack
```

## Toolchain versions

Pinned; never "latest". Rationale in [docs/13-DECISIONS.md](docs/13-DECISIONS.md) §12.

| Tool | Version |
|---|---|
| Rust | 1.89.0 |
| Solana CLI (Agave) | 3.1.10 |
| Anchor CLI | 1.1.2 |
| AVM | 1.1.2 |
| Node.js | 24.18.1 |
| pnpm | 12.3.4 |
| PostgreSQL | 17.11 (Docker image `postgres:17.11-alpine3.24`) |

The Solana/Anchor toolchain runs in Ubuntu on WSL, and the repository must live
in the WSL filesystem at `~/taskra`, not under `/mnt/c`.

## Setup

```bash
pnpm install
cp .env.example .env      # then fill in POSTGRES_PASSWORD and DATABASE_URL
pnpm db:up                # start local PostgreSQL
pnpm db:migrate           # apply migrations (none exist yet)
pnpm build
```

Environment variables and their `PUBLIC` / `SERVER_ONLY` / `SECRET` labels are
documented in [docs/10-ENVIRONMENT-SPEC.md](docs/10-ENVIRONMENT-SPEC.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm lint` | ESLint over the workspace |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm test` | Unit tests |
| `pnpm build` | Build every package |
| `pnpm --filter @taskra/web dev` | Web dev server on port 3000 |
| `pnpm --filter @taskra/api dev` | API dev server (reads `.env`) |
| `pnpm db:up` / `pnpm db:down` | Start / stop local PostgreSQL |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm --filter @taskra/api db:migrate:create <name>` | Create a SQL migration |
| `pnpm anchor:build` | Build the Anchor program (needs the WSL toolchain) |
| `pnpm anchor:test` | Run program tests (none exist until Phase 1) |
| `pnpm anchor:fmt` / `pnpm anchor:lint` | `cargo fmt --check` / `cargo clippy -D warnings` |
| `pnpm sdk:idl` | Regenerate the SDK's IDL module after `anchor build` |
| `pnpm sdk:validator-loop` | End-to-end SDK run against a local validator (about 3 minutes) |
| `scripts/mutation-check.sh` | Seed eight defects into the program; all must be caught |
| `scripts/deploy-devnet.sh --dry-run` | Preview the devnet deployment ([docs/11](docs/11-DEPLOYMENT-SPEC.md)); the owner runs the real one |

## Build order

1. Repository and toolchain (Phase 0)
2. Anchor program and tests (Phase 1)
3. SDK (Phase 2)
4. Database schema and API (Phase 3)
5. GitHub verification (Phase 4)
6. Frontend (Phase 5)
7. Integration (Phase 6)
8. End-to-end and demo hardening (Phase 7)

## Definition of done

A fresh user can execute:

Connect Wallet
→ Create Task
→ Fund Escrow
→ Accept Task
→ Submit Evidence
→ Verify Evidence
→ Approve
→ USDC Moves Onchain
→ Reputation Changes

without manually editing the database or blockchain state.
