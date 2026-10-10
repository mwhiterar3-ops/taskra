# Taskra — Deployment Specification

Development:
- Solana Devnet
- local PostgreSQL or configured hosted PostgreSQL
- local frontend/API

Production/demo:
- deploy web
- deploy API
- configure database
- configure GitHub OAuth/API
- deploy Anchor program to target Solana network
- verify program ID and configuration
- verify USDC mint configuration
- run migrations
- run smoke tests

The final deployed system must not depend on local filesystem state.

## Devnet program deployment

`scripts/deploy-devnet.sh` deploys the program and initializes the platform. It
is run by the project owner, never by automation: it fixes the program's upgrade
authority and the platform's time windows, and the windows can never be changed
afterwards (`13-DECISIONS.md` §15).

Prerequisites:

1. The pinned toolchain (`13-DECISIONS.md` §12) on PATH, in `~/taskra`.
2. Four separate keys (`13-DECISIONS.md` D14):
   - **Program keypair.** Its address must equal `declare_id!`. The one generated
     for this repository is `target/deploy/taskra-keypair.json` (git-ignored;
     back it up). With a different keypair, first run `anchor keys sync`, rebuild,
     run `pnpm sdk:idl`, re-run all tests and commit.
   - **Upgrade authority keypair.** Funded with devnet SOL; pays for the deploy
     and signs `initialize_platform`. Keep it off any server.
   - **Platform authority** address. A different key from the upgrade authority.
   - **Attester** address. A devnet-only key that will later live in the
     attestation service's secret store.
3. A **treasury** wallet (a fifth key, distinct from the authority and attester)
   and its USDC token account, created beforehand, for example with
   `spl-token create-account <USDC_MINT> --owner <TREASURY_WALLET> --url devnet`.
4. The devnet USDC mint, taken from Circle's official documentation.

Steps:

```bash
cd ~/taskra
export TASKRA_PROGRAM_KEYPAIR=target/deploy/taskra-keypair.json
export TASKRA_UPGRADE_AUTHORITY_KEYPAIR=/path/to/upgrade-authority.json
export TASKRA_PLATFORM_AUTHORITY=<address>
export TASKRA_ATTESTER=<address>
export TASKRA_TREASURY_TOKEN_ACCOUNT=<address>
export USDC_MINT=<devnet USDC mint from Circle>

scripts/deploy-devnet.sh --dry-run          # prints every step, changes nothing
scripts/deploy-devnet.sh --confirm-devnet   # deploys and initializes
```

The script refuses to run unless the RPC endpoint's genesis hash is devnet's, the
program keypair matches `declare_id!`, and the authority, attester and upgrade
authority are different keys. It initializes the platform with the devnet-demo
profile:

| Parameter | Value |
|---|---|
| `fee_bps` | 250 |
| `review_window` | 600 s (10 min) |
| `verification_grace` | 300 s (5 min) |
| `dispute_timeout` | 900 s (15 min) |
| Maximum client-fund lock | `work_duration + 35 min` |

Afterwards, set `TASKRA_PROGRAM_ID`, `NEXT_PUBLIC_TASKRA_PROGRAM_ID`, `USDC_MINT`
and `NEXT_PUBLIC_USDC_MINT` in the deployment environment, and record the
`initialize_platform` signature.

## Status

Nothing has been deployed to any public cluster or host. Everything below has
been exercised only on a local validator (`pnpm e2e`), except where a step is
marked **not verified**.

## Processes

| Process | Start (after `pnpm build`) | Listens | Needs |
|---|---|---|---|
| API | `pnpm --filter @taskra/api start` | `API_HOST:API_PORT` | Its environment (`10-ENVIRONMENT-SPEC.md`), PostgreSQL, a Solana RPC endpoint |
| Attestation service | `pnpm --filter @taskra/attester start` | nothing | Its own environment including `ATTESTER_SECRET_KEY`, PostgreSQL, RPC, outbound HTTPS to `api.github.com` |
| Web | `pnpm --filter @taskra/web start` | port 3000 | `NEXT_PUBLIC_*` at **build** time |

- Run exactly **one** attestation service. Two are safe (jobs are leased and an
  attestation can be recorded once) but waste transactions.
- The web app and the API must share a site (same registrable domain), because
  the session cookie is `SameSite=Strict`. Serve both over HTTPS: with
  `NODE_ENV=production` the cookie is `Secure`.
- `WEB_ORIGIN` must be the exact origin of the web app. It is the only origin
  CORS allows and the only one state-changing requests are accepted from.
- The API reads the client address from the socket. Behind a reverse proxy all
  clients share one address, so apply rate limits at the proxy as well, or the
  built-in per-address limits become a shared budget. Proxy-header trust is not
  configurable yet (**limitation**).

## Health checks

| Check | Use for | Healthy |
|---|---|---|
| `GET /health` | Liveness; restart the process if it fails | `200 {"status":"ok"}` |
| `GET /ready` | Readiness; route traffic only when it passes | `200`, `checks.database` and `checks.rpc` both `ok` |
| Attestation service | Its log line `attester started`; then `verification result recorded` / `record_attestation sent` as work arrives | It exits with code 1 and `refusing to start` if its key is not `platform.attester` |

## Database

- Migrate with `pnpm db:migrate`, using a login that owns the schema and can
  create roles. It is forward-only wherever data matters; never run a `Down`
  migration there, and never change the schema by hand.
- Create one login per service, each a member of only its role:

  ```sql
  CREATE ROLE taskra_api_login      LOGIN PASSWORD '...' IN ROLE taskra_api;
  CREATE ROLE taskra_attester_login LOGIN PASSWORD '...' IN ROLE taskra_attester;
  ```

  Give the API the first login's `DATABASE_URL` and the attestation service the
  second's. Neither service should have the migration login. The API refuses to
  start with it, or with any login that could act as the attestation role; the
  attestation service does not check its own.
- **Backup.** The database is the only copy of: task titles, descriptions and
  acceptance criteria; GitHub identity links; rejection reason text; and the
  verification audit trail. Take regular logical backups (`pg_dump`) and keep
  them as long as disputes may need the audit trail.
- **Recovery.** Restore the dump. Then nothing else is needed for financial
  facts: task state is read from Solana, and `settlements` rows are re-derived
  from finalized transactions the next time each task is read. Sessions are
  lost (users sign in again). An attestation that was `SENT` at backup time is
  reconciled against the chain on the next pass.
- Losing the database loses metadata, never funds: every exit path of the
  program works with a wallet and the SDK alone.

## Logging and errors

- Both services log JSON lines to stdout (pino). Collect stdout; nothing is
  written to local files.
- The API redacts `cookie`, `authorization` and `set-cookie`. Neither service
  logs request bodies, tokens or key material; the attester logs its public key
  only.
- Client-visible errors carry a code and a safe message. Unexpected errors are
  logged in full with `"msg":"unhandled error"` and returned as `500 INTERNAL`;
  alert on that message and on `settlement was not recorded`.

## Solana RPC

- Reads time out after 10 s and are retried twice (250 ms, 1 s); after that the
  API answers `503 RPC_UNAVAILABLE` with `Retry-After`, and task pages fall back
  to the cache marked `chainSource: "cache"`.
- The API trusts its RPC endpoint for what it records. Use an endpoint you
  operate or a provider you trust; the public devnet endpoint is rate-limited
  and acceptable only for a demo.
- Settlement discovery looks at the 25 most recent finalized transactions of a
  task account, which is ample for the 14-instruction lifecycle.

## Secrets and keys

| Secret | Held by | Rotation |
|---|---|---|
| `DATABASE_URL` passwords | Each service's secret store | `ALTER ROLE ... PASSWORD`, update the secret, restart that service |
| `GITHUB_CLIENT_SECRET` | API (and optionally the attestation service) | Generate a new secret in the GitHub OAuth app, update, restart, delete the old one |
| `ATTESTER_SECRET_KEY` | Attestation service only | Generate a new keypair; the platform authority signs `rotate_keys` with the new attester (the old key stops working at once); put the new key in the service's secret store; restart |
| Platform authority key | Offline / hardware wallet, never on a server | `rotate_keys`, signed by the current authority |
| Treasury wallet key | Offline / hardware wallet | Create a new USDC token account; `rotate_keys` with it as the new treasury |
| Program upgrade authority | Offline, separate from the platform authority | `solana program set-upgrade-authority` |

Key custody and recovery:

- No user key or seed phrase ever reaches Taskra. Users keep their own.
- The attester key is the only key on a server. It can be regenerated at any
  time; losing it costs nothing but a rotation. Keep no backup of it.
- The platform authority, treasury and upgrade-authority keys must be backed up
  offline. Losing the platform authority means disputes resolve only by the
  timeout fallback and keys can no longer be rotated. Losing the treasury key
  loses the fees in that account (the authority can rotate to a new treasury).
  Losing the upgrade authority freezes the program as deployed.
- If the attester key leaks: rotate it as above, then compare on-chain
  attestations with `verification_results`; an attestation with no VERIFIED row
  was made by the attacker. Clients can still reject within the review window.
- `scripts/deploy-devnet.sh` and `scripts/localnet.sh` are the only tooling that
  reads key files, and both take them from paths the operator supplies.

## Deployment script safety

`scripts/deploy-devnet.sh` refuses to run when: no mode is given; a required
value is missing; the toolchain versions differ from the pinned ones; the
program keypair does not match `declare_id!`; any two of the platform authority,
attester and upgrade authority are the same key; or (in `--confirm-devnet` mode)
the RPC endpoint's genesis hash is not devnet's. `scripts/test-deploy-guards.sh`
exercises each refusal and the dry run without sending anything.

## Devnet checklist (owner-run; **not verified here**)

1. Deploy and initialize: the steps under "Devnet program deployment" above.
2. Create a GitHub OAuth app. Callback URL:
   `https://<api-host>/api/v1/github/callback`. Set `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`.
3. Provision PostgreSQL, run `pnpm db:migrate`, create the two logins.
4. Fund the attester address with a little devnet SOL.
5. Set each process's environment and start the API, the attestation service
   and the web app (built with the `NEXT_PUBLIC_*` values).

Post-deployment verification:

- [ ] `solana program show <PROGRAM_ID> --url devnet` shows the expected upgrade authority.
- [ ] The Platform account's authority, attester, treasury, mint and windows are the intended ones.
- [ ] `GET /ready` answers 200.
- [ ] The attestation service logged `attester started` with the expected public key.
- [ ] Wallet sign-in works from the deployed web origin, and a `POST` from another origin answers 403.
- [ ] One task runs the full loop below, and its settlement transaction shows 97.50 / 2.50 USDC on the explorer.
- [ ] `/api/v1/users/<developer>/reputation` shows the settled task.

Before demo:
1. Create/fund a real test task.
2. Execute developer acceptance.
3. Submit real-shaped GitHub evidence.
4. Verify evidence.
5. Approve.
6. Confirm USDC settlement.
7. Confirm reputation update.
8. Save transaction signatures for the demo.
