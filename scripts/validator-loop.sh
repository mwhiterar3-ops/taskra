#!/usr/bin/env bash
# SDK exit criterion: one command that proves the SDK against a real validator.
#
# Builds the program, starts a throwaway solana-test-validator with the program
# deployed as an upgradeable program, and runs packages/sdk/e2e/validator-loop.ts,
# which creates a real SPL mint, initializes the platform with a short-window
# test profile and drives every loop through the SDK.
#
# Usage: scripts/validator-loop.sh      (or: pnpm sdk:validator-loop)
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${TASKRA_LOOP_RPC_PORT:-18899}"
FAUCET_PORT="${TASKRA_LOOP_FAUCET_PORT:-19900}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

for tool in anchor solana solana-keygen solana-test-validator pnpm node; do
  command -v "$tool" >/dev/null || { echo "error: $tool is not on PATH" >&2; exit 1; }
done

WORK="$(mktemp -d -t taskra-validator-loop.XXXXXX)"
VALIDATOR_PID=""
cleanup() {
  if [ -n "$VALIDATOR_PID" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "--- building the program"
anchor build >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 1; }

PROGRAM_ID="$(solana-keygen pubkey target/deploy/taskra-keypair.json)"
IDL_ADDRESS="$(node -e 'console.log(require("./target/idl/taskra.json").address)')"
if [ "$PROGRAM_ID" != "$IDL_ADDRESS" ]; then
  echo "error: program keypair ($PROGRAM_ID) does not match the IDL address ($IDL_ADDRESS)" >&2
  exit 1
fi

# A throwaway upgrade authority for this run only; it never leaves $WORK.
solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/upgrade-authority.json"
UPGRADE_AUTHORITY="$(solana-keygen pubkey "$WORK/upgrade-authority.json")"

echo "--- starting solana-test-validator on ${RPC_URL}"
echo "    program            $PROGRAM_ID"
echo "    upgrade authority  $UPGRADE_AUTHORITY"
solana-test-validator \
  --ledger "$WORK/ledger" \
  --reset \
  --quiet \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --upgradeable-program "$PROGRAM_ID" target/deploy/taskra.so "$UPGRADE_AUTHORITY" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 60); do
  if solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "error: the validator exited during startup" >&2
    tail -40 "$WORK/validator.log" >&2
    exit 1
  fi
  sleep 1
done
solana cluster-version --url "$RPC_URL" >/dev/null || {
  echo "error: the validator did not become ready" >&2
  exit 1
}
echo "    validator          $(solana cluster-version --url "$RPC_URL")"

echo "--- running the SDK loops"
cd packages/sdk
RPC_URL="$RPC_URL" TASKRA_UPGRADE_AUTHORITY_KEYPAIR="$WORK/upgrade-authority.json" \
  node --import tsx e2e/validator-loop.ts
