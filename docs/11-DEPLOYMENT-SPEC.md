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

Before demo:
1. Create/fund a real test task.
2. Execute developer acceptance.
3. Submit real-shaped GitHub evidence.
4. Verify evidence.
5. Approve.
6. Confirm USDC settlement.
7. Confirm reputation update.
8. Save transaction signatures for the demo.
