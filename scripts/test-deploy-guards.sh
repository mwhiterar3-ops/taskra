#!/usr/bin/env bash
# Checks that scripts/deploy-devnet.sh refuses unsafe configurations, and that
# its dry run changes nothing. Nothing is deployed and no cluster is contacted:
# the one case that reaches the network step points at a closed local port.
#
# Usage: scripts/test-deploy-guards.sh
#
# Needs the owner's program keypair (target/deploy/taskra-keypair.json, the one
# whose address is declare_id!). It is git-ignored, so this check cannot run
# from a fresh clone; it is a tool for whoever holds the deployment key.
set -u
cd "$(dirname "$0")/.." || exit 1

PROGRAM_KEYPAIR=target/deploy/taskra-keypair.json
[ -f "$PROGRAM_KEYPAIR" ] || { echo "error: $PROGRAM_KEYPAIR is missing; run 'anchor build' first" >&2; exit 1; }

WORK="$(mktemp -d -t taskra-deploy-guards.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
for name in upgrade authority attester treasury other-program; do
  solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/$name.json"
done
UPGRADE="$(solana-keygen pubkey "$WORK/upgrade.json")"
AUTHORITY="$(solana-keygen pubkey "$WORK/authority.json")"
ATTESTER="$(solana-keygen pubkey "$WORK/attester.json")"
TREASURY="$(solana-keygen pubkey "$WORK/treasury.json")"
# Any well-formed address will do for a dry run; this is the SPL Token program id.
MINT="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

failures=0

# expect <name> <refuse|accept> <text the output must contain> -- <deploy args...>
expect() {
  local name="$1" want="$2" text="$3"
  shift 4
  local output status
  output="$(env -u TASKRA_PROGRAM_KEYPAIR -u TASKRA_UPGRADE_AUTHORITY_KEYPAIR \
    -u TASKRA_PLATFORM_AUTHORITY -u TASKRA_ATTESTER -u TASKRA_TREASURY_TOKEN_ACCOUNT \
    -u USDC_MINT -u RPC_URL scripts/deploy-devnet.sh "$@" 2>&1)"
  status=$?
  local ok=1
  if [ "$want" = refuse ] && [ "$status" -eq 0 ]; then ok=0; fi
  if [ "$want" = accept ] && [ "$status" -ne 0 ]; then ok=0; fi
  if ! printf '%s' "$output" | grep -qF -- "$text"; then ok=0; fi
  # Whatever else happens, a refused run must never claim a deployment.
  if [ "$want" = refuse ] && printf '%s' "$output" | grep -q '^Deployed\.'; then ok=0; fi
  if [ "$ok" -eq 1 ]; then
    echo "ok: $name"
  else
    echo "FAILED: $name (exit $status)"
    printf '%s\n' "$output" | tail -5 | sed 's/^/    /'
    failures=$((failures + 1))
  fi
}

good=(--program-keypair "$PROGRAM_KEYPAIR" --upgrade-authority-keypair "$WORK/upgrade.json"
  --platform-authority "$AUTHORITY" --attester "$ATTESTER"
  --treasury-token-account "$TREASURY" --usdc-mint "$MINT")

expect "refuses to run without a mode" refuse "pass --dry-run to preview" -- "${good[@]}"
expect "refuses an unknown argument" refuse "unknown argument" -- --dry-run --mainnet
expect "refuses when a required value is missing" refuse "TASKRA_ATTESTER is required" -- \
  --dry-run --program-keypair "$PROGRAM_KEYPAIR" --upgrade-authority-keypair "$WORK/upgrade.json" \
  --platform-authority "$AUTHORITY" --treasury-token-account "$TREASURY" --usdc-mint "$MINT"
expect "refuses a program keypair that does not match declare_id!" refuse "but the program declares" -- \
  --dry-run "${good[@]}" --program-keypair "$WORK/other-program.json"
expect "refuses a missing upgrade authority keypair file" refuse "keypair file not found" -- \
  --dry-run "${good[@]}" --upgrade-authority-keypair "$WORK/absent.json"
expect "refuses platform authority = upgrade authority" refuse "must differ from the upgrade authority" -- \
  --dry-run "${good[@]}" --platform-authority "$UPGRADE"
expect "refuses platform authority = attester" refuse "must differ from the attester" -- \
  --dry-run "${good[@]}" --attester "$AUTHORITY"
expect "refuses attester = upgrade authority" refuse "attester must differ from the upgrade authority" -- \
  --dry-run "${good[@]}" --attester "$UPGRADE"
expect "dry run prints the plan and changes nothing" accept "Dry run complete: nothing was built, deployed or sent." -- \
  --dry-run "${good[@]}"
expect "dry run shows the permanent windows" accept "max client-fund lock    work_duration + 2100 s" -- \
  --dry-run "${good[@]}"
# A real run against anything that is not devnet must stop before building or deploying.
expect "refuses to deploy to an endpoint that is not devnet" refuse "" -- \
  --confirm-devnet "${good[@]}" --rpc-url http://127.0.0.1:1

if [ "$failures" -gt 0 ]; then
  echo "RESULT: $failures deploy guard check(s) failed"
  exit 1
fi
echo "RESULT: all deploy guard checks passed"
