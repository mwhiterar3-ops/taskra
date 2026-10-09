#!/usr/bin/env bash
# Mutation check for the off-chain code: the API, the attestation service and
# the web app's transaction logic.
#
# Seeds one security-relevant defect at a time, runs the three unit/integration
# suites, and requires at least one test to fail. Each mutation is reverted with
# git before the next. A passing suite proves little unless a broken
# implementation fails it; this is that check.
#
# Usage: scripts/mutation-check-services.sh     (clean tree; about two minutes)
set -u
cd "$(dirname "$0")/.." || exit 1

SRC="apps/api/src apps/attester/src apps/web/src"
# shellcheck disable=SC2086
if ! git diff --quiet -- $SRC; then
  echo "error: $SRC has uncommitted changes; commit or stash them first" >&2
  exit 1
fi
pnpm build:packages >/tmp/taskra-mutation-packages.log 2>&1 || {
  echo "error: packages do not build" >&2
  exit 1
}

survivors=0
total=0

run_suites() {
  local failed=0 app
  for app in api attester web; do
    (cd "apps/$app" && NO_COLOR=1 npx vitest run >"/tmp/taskra-mutation-$app.log" 2>&1) || failed=$((failed + 1))
  done
  return "$failed"
}

# mutate <name> <perl substitution> <file>
mutate() {
  local name="$1" substitution="$2" file="$3"
  total=$((total + 1))
  perl -0pi -e "$substitution" "$file"
  if git diff --quiet -- "$file"; then
    echo "MUTATION '$name': pattern not found, nothing was changed"
    survivors=$((survivors + 1))
    return
  fi
  if run_suites; then
    echo "MUTATION '$name': SURVIVED"
    survivors=$((survivors + 1))
  else
    local example
    example=$(grep -hE '^ (FAIL|×)|^\s+×' /tmp/taskra-mutation-api.log /tmp/taskra-mutation-attester.log /tmp/taskra-mutation-web.log | head -2 | sed 's/^\s*/    /')
    echo "MUTATION '$name': CAUGHT, e.g."
    echo "$example"
  fi
  git checkout -- "$file"
}

mutate "1. login nonce can be used more than once" \
  's/WHERE nonce = \$1 AND consumed_at IS NULL AND expires_at > \$2/WHERE nonce = \$1 AND expires_at > \$2/' \
  apps/api/src/auth/routes.ts

mutate "2. login signature is not verified" \
  's/if \(!verifyWalletSignature\(/if (false \&\& !verifyWalletSignature(/' \
  apps/api/src/auth/routes.ts

mutate "3. expired sessions are accepted" \
  's/revoked_at IS NULL AND expires_at > \$2/revoked_at IS NULL AND \$2::timestamptz IS NOT NULL/' \
  apps/api/src/auth/routes.ts

mutate "4. state-changing requests from other origins are accepted" \
  's/request\.headers\.origin !== webOrigin/false/' \
  apps/api/src/app.ts

mutate "5. settlement recorded from a confirmed (not finalized) account" \
  "s/const finalized = await chain\.getTask\(address, 'finalized'\);/const finalized = await chain.getTask(address, 'confirmed');/" \
  apps/api/src/tasks/reconcile.ts

mutate "6. a reported transaction for another task is accepted" \
  "s/if \(instruction\.accounts\['task'\] !== row\.task_address\) \{/if (false) {/" \
  apps/api/src/tasks/reconcile.ts

mutate "7. stored metadata is always reported as matching the chain" \
  's/return termsMatchTask\(/return true || termsMatchTask(/' \
  apps/api/src/tasks/reconcile.ts

mutate "8. evidence accepted from a wallet that is not the developer" \
  's/if \(account\.developer\?\.toBase58\(\) !== session\.wallet\) \{/if (false) {/' \
  apps/api/src/tasks/routes.ts

mutate "9. a self-merged pull request is verified (R6)" \
  's/pr\.mergedBy\.id === pr\.author\.id/false/' \
  apps/attester/src/rules.ts

mutate "10. the evidence hash is not compared with the chain (R9)" \
  's/recomputed === toHex\(task\.evidenceHash\)/true/' \
  apps/attester/src/rules.ts

mutate "11. a superseded submission is still verified (P2)" \
  's/task\.submissionNonce !== submission\.submissionNonce \|\|/false \&\& task.submissionNonce !== submission.submissionNonce ||/' \
  apps/attester/src/rules.ts

mutate "12. a GitHub outage is treated as an answer (R10)" \
  "s/response\.status !== 200/response.status >= 600/" \
  apps/attester/src/github.ts

mutate "13. the attestation is marked final at confirmed commitment" \
  "s/const finalized = await chain\.getTask\(address, 'finalized'\);\n    if \(finalized !== null/const finalized = await chain.getTask(address, 'confirmed');\n    if (finalized !== null/" \
  apps/attester/src/worker.ts

mutate "14. the web app reports a confirmed transaction as final" \
  "s/if \(level === 'finalized'\) return emit/if (level === 'confirmed' || level === 'finalized') return emit/" \
  apps/web/src/lib/transaction.ts

mutate "15. a session for another wallet counts as signed in" \
  's/sessionWallet === address/sessionWallet !== null/' \
  apps/web/src/state/app-context.tsx

mutate "16. the developer may dispute before the window opens" \
  's/now > task\.disputeOpenAt && now <= task\.refundOpenAt/now <= task.refundOpenAt/' \
  apps/web/src/lib/actions.ts

if [ "$survivors" -gt 0 ]; then
  echo "RESULT: $survivors of $total mutation(s) not caught"
  exit 1
fi
echo "RESULT: all $total mutations caught"
