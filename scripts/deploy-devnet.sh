#!/usr/bin/env bash
# Deploys the Taskra program to Solana devnet and initializes the platform with
# the devnet-demo profile (docs/13-DECISIONS.md §15).
#
# THIS SCRIPT FIXES THE PROGRAM'S UPGRADE AUTHORITY AND THE PLATFORM'S TIME
# WINDOWS. Both are permanent for this program address: the windows cannot be
# changed after initialize_platform. Read docs/11-DEPLOYMENT-SPEC.md first.
#
# Required environment (or the matching --flag):
#   TASKRA_PROGRAM_KEYPAIR            path to the program keypair. Its address must
#                                     equal declare_id! / the IDL address.
#   TASKRA_UPGRADE_AUTHORITY_KEYPAIR  path to the upgrade authority keypair. Pays
#                                     for the deploy and signs initialize_platform.
#   TASKRA_PLATFORM_AUTHORITY         address: resolves disputes, rotates keys.
#   TASKRA_ATTESTER                   address: records attestations.
#   TASKRA_TREASURY_TOKEN_ACCOUNT     address of an existing USDC token account
#                                     owned by the treasury wallet.
#   USDC_MINT                         devnet USDC mint, from Circle's documentation.
# Optional:
#   RPC_URL                           default https://api.devnet.solana.com
#
# Usage:
#   scripts/deploy-devnet.sh --dry-run          print every step, change nothing
#   scripts/deploy-devnet.sh --confirm-devnet   deploy and initialize
set -euo pipefail
cd "$(dirname "$0")/.."

# devnet-demo profile. Never use these windows where real funds are at stake.
FEE_BPS=250
REVIEW_WINDOW=600        # 10 minutes
VERIFICATION_GRACE=300   # 5 minutes
DISPUTE_TIMEOUT=900      # 15 minutes

DEVNET_GENESIS_HASH="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --confirm-devnet) MODE="deploy" ;;
    --program-keypair) TASKRA_PROGRAM_KEYPAIR="$2"; shift ;;
    --upgrade-authority-keypair) TASKRA_UPGRADE_AUTHORITY_KEYPAIR="$2"; shift ;;
    --platform-authority) TASKRA_PLATFORM_AUTHORITY="$2"; shift ;;
    --attester) TASKRA_ATTESTER="$2"; shift ;;
    --treasury-token-account) TASKRA_TREASURY_TOKEN_ACCOUNT="$2"; shift ;;
    --usdc-mint) USDC_MINT="$2"; shift ;;
    --rpc-url) RPC_URL="$2"; shift ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  echo "error: pass --dry-run to preview or --confirm-devnet to deploy" >&2
  exit 2
fi

fail() { echo "error: $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || fail "$1 is required"; }
for variable in TASKRA_PROGRAM_KEYPAIR TASKRA_UPGRADE_AUTHORITY_KEYPAIR TASKRA_PLATFORM_AUTHORITY \
  TASKRA_ATTESTER TASKRA_TREASURY_TOKEN_ACCOUNT USDC_MINT; do
  need "$variable"
done
for tool in anchor solana solana-keygen pnpm node; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
[ -f "$TASKRA_PROGRAM_KEYPAIR" ] || fail "program keypair file not found"
[ -f "$TASKRA_UPGRADE_AUTHORITY_KEYPAIR" ] || fail "upgrade authority keypair file not found"

solana --version | grep -q "3.1.10" || fail "expected solana-cli 3.1.10 (see docs/13-DECISIONS.md §12)"
anchor --version | grep -q "1.1.2" || fail "expected anchor-cli 1.1.2 (see docs/13-DECISIONS.md §12)"

PROGRAM_ID="$(solana-keygen pubkey "$TASKRA_PROGRAM_KEYPAIR")"
UPGRADE_AUTHORITY="$(solana-keygen pubkey "$TASKRA_UPGRADE_AUTHORITY_KEYPAIR")"
DECLARED_ID="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' programs/taskra/src/lib.rs)"

[ "$PROGRAM_ID" = "$DECLARED_ID" ] || fail \
  "program keypair is $PROGRAM_ID but the program declares $DECLARED_ID. Use the matching keypair, or run 'anchor keys sync', rebuild, 'pnpm sdk:idl', and commit before deploying."

# Key separation is enforced on-chain as well; failing here is cheaper.
[ "$TASKRA_PLATFORM_AUTHORITY" != "$UPGRADE_AUTHORITY" ] || fail "platform authority must differ from the upgrade authority"
[ "$TASKRA_PLATFORM_AUTHORITY" != "$TASKRA_ATTESTER" ] || fail "platform authority must differ from the attester"
[ "$TASKRA_ATTESTER" != "$UPGRADE_AUTHORITY" ] || fail "attester must differ from the upgrade authority"

cat <<SUMMARY
Taskra devnet deployment ($MODE)
  rpc                     $RPC_URL
  program id              $PROGRAM_ID
  upgrade authority       $UPGRADE_AUTHORITY   (PERMANENT for this deployment unless transferred)
  platform authority      $TASKRA_PLATFORM_AUTHORITY
  attester                $TASKRA_ATTESTER
  treasury token account  $TASKRA_TREASURY_TOKEN_ACCOUNT
  usdc mint               $USDC_MINT
  fee                     $FEE_BPS bps
  review window           $REVIEW_WINDOW s    (PERMANENT)
  verification grace      $VERIFICATION_GRACE s    (PERMANENT)
  dispute timeout         $DISPUTE_TIMEOUT s    (PERMANENT)
  max client-fund lock    work_duration + $(((REVIEW_WINDOW > VERIFICATION_GRACE ? REVIEW_WINDOW : VERIFICATION_GRACE) + REVIEW_WINDOW + DISPUTE_TIMEOUT)) s
SUMMARY

run() {
  echo "+ $*"
  if [ "$MODE" = "deploy" ]; then "$@"; fi
}

if [ "$MODE" = "deploy" ]; then
  GENESIS="$(solana genesis-hash --url "$RPC_URL")"
  [ "$GENESIS" = "$DEVNET_GENESIS_HASH" ] || fail "$RPC_URL is not devnet (genesis hash $GENESIS)"
else
  echo "+ (dry run) would verify that $RPC_URL has the devnet genesis hash $DEVNET_GENESIS_HASH"
fi

run anchor build
run solana program deploy target/deploy/taskra.so \
  --url "$RPC_URL" \
  --program-id "$TASKRA_PROGRAM_KEYPAIR" \
  --upgrade-authority "$TASKRA_UPGRADE_AUTHORITY_KEYPAIR" \
  --keypair "$TASKRA_UPGRADE_AUTHORITY_KEYPAIR"
run solana program show "$PROGRAM_ID" --url "$RPC_URL"

export RPC_URL USDC_MINT TASKRA_UPGRADE_AUTHORITY_KEYPAIR TASKRA_PLATFORM_AUTHORITY \
  TASKRA_ATTESTER TASKRA_TREASURY_TOKEN_ACCOUNT
export TASKRA_CLUSTER=devnet
export TASKRA_FEE_BPS="$FEE_BPS" TASKRA_REVIEW_WINDOW="$REVIEW_WINDOW" \
  TASKRA_VERIFICATION_GRACE="$VERIFICATION_GRACE" TASKRA_DISPUTE_TIMEOUT="$DISPUTE_TIMEOUT"
run pnpm --filter @taskra/sdk exec node --import tsx e2e/initialize-platform.ts

if [ "$MODE" = "dry-run" ]; then
  echo "Dry run complete: nothing was built, deployed or sent."
else
  echo "Deployed. Record the program id and the initialize_platform signature above."
fi
