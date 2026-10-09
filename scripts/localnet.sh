#!/usr/bin/env bash
# A local Solana validator with the Taskra program, a test USDC mint and an
# initialized platform, for running the whole product on one machine.
#
#   scripts/localnet.sh                    start it (stays in the foreground; Ctrl-C stops it)
#   scripts/localnet.sh fund <wallet> [n]  give a wallet 5 SOL and n test USDC (default 1000)
#
# State lives in .localnet/ (git-ignored) and is recreated on every start: the
# ledger is reset, so the mint address changes each time. After starting, copy
# the values printed to .localnet/env into .env and restart the API, the
# attestation service and the web app.
#
# The keys under .localnet/keys are throwaway local keys. Never reuse them.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${TASKRA_LOCALNET_RPC_PORT:-8899}"
export RPC_URL="http://127.0.0.1:${RPC_PORT}"

if [ "${1:-}" = "fund" ]; then
  [ -n "${2:-}" ] || { echo "usage: scripts/localnet.sh fund <wallet> [usdc]" >&2; exit 2; }
  cd apps/e2e
  exec node --import tsx src/localnet.ts fund "$2" "${3:-1000}"
fi

for tool in anchor solana solana-keygen solana-test-validator pnpm node; do
  command -v "$tool" >/dev/null || { echo "error: $tool is not on PATH" >&2; exit 1; }
done

mkdir -p .localnet/keys
chmod 700 .localnet .localnet/keys
VALIDATOR_PID=""
cleanup() {
  if [ -n "$VALIDATOR_PID" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "--- building the program and the packages"
anchor build >.localnet/build.log 2>&1 || { tail -40 .localnet/build.log; exit 1; }
pnpm build:packages >.localnet/packages.log 2>&1 || { tail -40 .localnet/packages.log; exit 1; }

PROGRAM_ID="$(solana-keygen pubkey target/deploy/taskra-keypair.json)"
if [ ! -f .localnet/keys/upgrade-authority.json ]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile .localnet/keys/upgrade-authority.json
fi
UPGRADE_AUTHORITY="$(solana-keygen pubkey .localnet/keys/upgrade-authority.json)"

echo "--- starting solana-test-validator on ${RPC_URL}"
solana-test-validator \
  --ledger .localnet/ledger \
  --reset \
  --quiet \
  --rpc-port "$RPC_PORT" \
  --upgradeable-program "$PROGRAM_ID" target/deploy/taskra.so "$UPGRADE_AUTHORITY" \
  >.localnet/validator.log 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 60); do
  solana cluster-version --url "$RPC_URL" >/dev/null 2>&1 && break
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "error: the validator exited during startup" >&2
    tail -40 .localnet/validator.log >&2
    exit 1
  fi
  sleep 1
done
solana cluster-version --url "$RPC_URL" >/dev/null || { echo "error: the validator did not become ready" >&2; exit 1; }

(cd apps/e2e && TASKRA_UPGRADE_AUTHORITY_KEYPAIR="$PWD/../../.localnet/keys/upgrade-authority.json" \
  node --import tsx src/localnet.ts init)

echo
echo "The validator is running. Leave this terminal open; press Ctrl-C to stop it."
wait "$VALIDATOR_PID"
