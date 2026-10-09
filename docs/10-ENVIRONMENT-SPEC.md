# Taskra — Environment Specification

`.env.example` is the template. Copy it to `.env` and fill in the blanks. Never
commit real secrets; `.env` and every `.env.*` file except `.env.example` are
git-ignored.

## Labels

Every variable carries exactly one label.

| Label | Meaning |
|---|---|
| `PUBLIC` | Inlined into the browser bundle and visible to everyone. Always named `NEXT_PUBLIC_*`. |
| `SERVER_ONLY` | Read by server processes only. Not confidential, but never sent to the browser. |
| `SECRET` | Confidential. Lives only in a secret store or a local `.env`. Never logged, never committed, never given a value in `.env.example`. |

Never expose server variables through frontend build variables.

## Variables

### Runtime

| Variable | Label | Description |
|---|---|---|
| `NODE_ENV` | SERVER_ONLY | `development`, `test` or `production`. |
| `API_HOST` | SERVER_ONLY | Interface the API listens on. |
| `API_PORT` | SERVER_ONLY | Port the API listens on (1–65535). |
| `WEB_ORIGIN` | SERVER_ONLY | Origin of the web app, used for CORS. |

### Blockchain

| Variable | Label | Description |
|---|---|---|
| `SOLANA_NETWORK` | SERVER_ONLY | `localnet`, `devnet` or `mainnet-beta`. Devnet is the default. |
| `SOLANA_RPC_URL` | SERVER_ONLY | RPC endpoint. The public devnet endpoint is acceptable for local development. |
| `TASKRA_PROGRAM_ID` | SERVER_ONLY | Deployed Taskra program address. |
| `USDC_MINT` | SERVER_ONLY | USDC mint for the target network, taken from Circle's official documentation. Never invented or hardcoded in source. |

### Database

| Variable | Label | Description |
|---|---|---|
| `DATABASE_URL` | SECRET | `postgres://` connection string; contains the password. |
| `POSTGRES_USER` | SERVER_ONLY | Local docker-compose database user. |
| `POSTGRES_DB` | SERVER_ONLY | Local docker-compose database name. |
| `POSTGRES_PORT` | SERVER_ONLY | Host port for the local docker-compose database. |
| `POSTGRES_PASSWORD` | SECRET | Local docker-compose database password. |

The `POSTGRES_*` variables are read only by `docker-compose.yml`.

### GitHub

| Variable | Label | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | SERVER_ONLY | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | SECRET | GitHub OAuth app client secret. |

`GITHUB_WEBHOOK_SECRET` was removed: the MVP verifies evidence on demand through
the GitHub REST API and uses no webhooks. If webhooks are introduced it returns as
a `SECRET`.

### Frontend public config

| Variable | Label | Description |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_NETWORK` | PUBLIC | Network shown to and used by the browser. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | PUBLIC | RPC endpoint used by the browser. |
| `NEXT_PUBLIC_TASKRA_PROGRAM_ID` | PUBLIC | Deployed Taskra program address. |
| `NEXT_PUBLIC_USDC_MINT` | PUBLIC | USDC mint for the target network. |
| `NEXT_PUBLIC_API_URL` | PUBLIC | Base URL of the Taskra API. |

### Attestation service

| Variable | Label | Description |
|---|---|---|
| `ATTESTER_SECRET_KEY` | SECRET | The attester keypair, as the JSON array of 64 bytes that `solana-keygen` writes. |

This is the attester keypair approved in `docs/13-DECISIONS.md` §7.4, the only
privileged backend signing key Taskra has. It is read **only** by
`apps/attester`; the API's configuration does not load it even when it is
present in the environment, and it must not be given to the API host or the web
app. It must be a devnet/test key during development. Its public key must equal
`platform.attester`, or the service refuses to start.

In a deployment the attestation service has its own environment containing
`NODE_ENV`, `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `TASKRA_PROGRAM_ID`, `USDC_MINT`,
its own `DATABASE_URL` (a login that is a member of `taskra_attester` only),
`ATTESTER_SECRET_KEY`, and optionally the GitHub client id and secret.

### Tests

| Variable | Label | Description |
|---|---|---|
| `TASKRA_TEST_DATABASE_URL` | SECRET | Optional. Admin connection string of a PostgreSQL server for the test suites to create throwaway databases on. Unset, the suites start an ephemeral PostgreSQL themselves. Never point it at a server holding real data. |

It is read only by the test harness and is not part of `.env.example`.

## Validation

The contract is enforced in code by `packages/shared/src/env`:

- `loadPublicEnv` validates the `PUBLIC` variables; `loadServerEnv` validates the
  `SERVER_ONLY` and `SECRET` variables.
- Missing and empty values are rejected with the variable's name. Error messages
  never contain values.
- Addresses must be base58 strings that decode to 32 bytes; URLs must use the
  expected scheme; the port must be an integer in range.
- Tests assert that the two schemas share no variable, that every `PUBLIC`
  variable is `NEXT_PUBLIC_*`, that `.env.example` labels every variable, and
  that no `SECRET` has a value in `.env.example`.

A process validates only the variables it consumes:

| Process | Variables |
|---|---|
| API (`apps/api`) | Runtime, Blockchain, `DATABASE_URL`; the GitHub pair is optional (without it, linking a GitHub identity answers `503 GITHUB_NOT_CONFIGURED`) |
| Attestation service (`apps/attester`) | `NODE_ENV`, Blockchain, `DATABASE_URL`, `ATTESTER_SECRET_KEY`; the GitHub pair is optional |
| Web (`apps/web`) | The `NEXT_PUBLIC_*` variables |

## Toolchain versions

Never use "latest". The rationale for each pin is in `docs/13-DECISIONS.md` §12.

| Tool | Version | Pinned in |
|---|---|---|
| Rust | 1.89.0 | `rust-toolchain.toml`, `Cargo.toml` |
| Solana CLI (Agave) | 3.1.10 | `Anchor.toml` |
| Anchor CLI | 1.1.2 | `Anchor.toml`, `programs/taskra/Cargo.toml` |
| AVM | 1.1.2 | — (installs the Anchor CLI) |
| Node.js | 24.18.1 | `.nvmrc`, `package.json` `engines` |
| pnpm | 12.3.4 | `package.json` `packageManager` |
| PostgreSQL | 17.11 | `docker-compose.yml` |

The repository must live inside the WSL filesystem at `~/taskra`, not under
`/mnt/c`.
