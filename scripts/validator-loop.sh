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

# The program's address is the one declared in the source (declare_id!) and
# carried by the freshly built IDL. A local validator loads the program at
# whatever address it is given, so no program keypair is needed here: the
# keypair is git-ignored, and a fresh clone only has a random one. Only a real
# deployment needs the matching key (scripts/deploy-devnet.sh checks that).
PROGRAM_ID="$(node -e 'console.log(require("./target/idl/taskra.json").address)')"
DECLARED_ID="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' programs/taskra/src/lib.rs)"
if [ -z "$PROGRAM_ID" ] || [ "$PROGRAM_ID" != "$DECLARED_ID" ]; then
  echo "error: the built IDL address ($PROGRAM_ID) is not the address the program declares ($DECLARED_ID)" >&2
  exit 1
fi
if ! grep -q "address: '$PROGRAM_ID'" packages/sdk/src/generated/idl.ts; then
  echo "error: the SDK's generated IDL is for a different program address; run 'pnpm sdk:idl'" >&2
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
