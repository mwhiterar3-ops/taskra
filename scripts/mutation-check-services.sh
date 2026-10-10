#!/usr/bin/env bash
# Mutation check for the off-chain code: the API, the attestation service and
# the web app's transaction logic.
#
# Seeds one security-relevant defect at a time, runs the three unit/integration
# suites, and requires at least one test to fail. Each mutation is reverted with
# git before the next. A passing suite proves little unless a broken
# implementation fails it; this is that check.
#
# Usage: scripts/mutation-check-services.sh     (clean tree; about three minutes)
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
  "s/if \(decoded\.accounts\['task'\] === task\) found\.push/if (true) found.push/" \
  apps/api/src/chain/parse.ts

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

mutate "17. an escrow transfer is counted whoever signed it" \
  's/authority !== expected\.task\n/false\n/' \
  apps/api/src/chain/parse.ts

mutate "24. the escrow's closure is counted whoever signed it" \
  's/inner\.accounts\[2\] !== expected\.task/false/' \
  apps/api/src/chain/parse.ts

mutate "18. escrow payments to accounts the instruction did not name are accepted" \
  's/if \(!allowed\.has\(destination\)\) \{/if (false) {/' \
  apps/api/src/tasks/reconcile.ts

mutate "19. the fee recorded for a settlement is not checked against the task" \
  's/sent\(treasury\) === expectedFee && //' \
  apps/api/src/tasks/reconcile.ts

mutate "20. a pull request made for another task is verified (R11)" \
  's/trailers\.tasks\[0\] !== taskId/false/' \
  apps/attester/src/rules.ts

mutate "21. a pull request naming another wallet is verified (R12)" \
  's/trailers\.developers\[0\] !== input\.developerWallet/false/' \
  apps/attester/src/rules.ts

mutate "22. a verified submission can be pointed at another pull request" \
  's/IF NEW\.pr_number IS DISTINCT FROM OLD\.pr_number AND \(/IF false AND (/' \
  apps/api/migrations/1760100000000_evidence-correction.sql

mutate "25. a second Taskra instruction hides a settlement from the API (N-1)" \
  's/if \(calls\.length === 0\) \{/if (calls.length !== 1) {/' \
  apps/api/src/chain/parse.ts

mutate "26. a settlement made through another program is passed over silently (N-1)" \
  's/wrapped \?\?= signature;/void signature;/' \
  apps/api/src/tasks/reconcile.ts

mutate "27. a VERIFIED result is recorded for a number that is no longer registered (N-2)" \
  's/IF NOT FOUND THEN/IF false THEN/' \
  apps/api/migrations/1760300000000_verified-result-matches-registration.sql

mutate "28. the VERIFIED record does not lock the registration it is about (N-2)" \
  's/UPDATE submissions s SET pr_number = s\.pr_number\n/PERFORM 1 FROM submissions s\n/' \
  apps/api/migrations/1760300000000_verified-result-matches-registration.sql

mutate "29. tokens swept out of the escrow are recorded as earnings (N-3)" \
  's/\{ fee: expectedFee, developer: net, client: 0n \}/{ fee: expectedFee, developer: sent(developerToken), client: 0n }/' \
  apps/api/src/tasks/reconcile.ts

mutate "30. a result for the old number is shown for a corrected registration (N-2)" \
  's/WHERE v\.submission_id = s\.id AND v\.pr_number = s\.pr_number/WHERE v.submission_id = s.id/' \
  apps/api/src/tasks/view.ts

mutate "31. the registration is only locked, not rewritten, by the VERIFIED record (N-2)" \
  's/UPDATE submissions s SET pr_number = s\.pr_number\n   WHERE s\.id = NEW\.submission_id AND s\.pr_number = NEW\.pr_number;/PERFORM 1 FROM submissions s WHERE s.id = NEW.submission_id AND s.pr_number = NEW.pr_number FOR SHARE;/' \
  apps/api/migrations/1760300000000_verified-result-matches-registration.sql

mutate "32. the Task account is not compared with the task the record names" \
  's/taskIdMatches: uuidFromTaskId\(account\.taskId\) === submission\.task_id\.toLowerCase\(\),/taskIdMatches: true,/' \
  apps/attester/src/worker.ts

mutate "33. an outcome whose transaction was not found goes unreported (L-07)" \
  's/throw new SettlementEvidenceError\(\n    `the task is /void new SettlementEvidenceError(\n    `the task is /' \
  apps/api/src/tasks/reconcile.ts

mutate "34. a settlement record may divide more than the task amount (N-3)" \
  's/fee_amount \+ developer_amount = amount/fee_amount + developer_amount >= amount/' \
  apps/api/migrations/1760400000000_settlement-amounts-add-up.sql

mutate "35. a login that is a member of the attester role is accepted by the API" \
  's/login\.attester \? .is a member of taskra_attester. : null/null/' \
  apps/api/src/startup.ts

mutate "36. the OAuth state cookie can be set by a sibling subdomain on https (L-10)" \
  's/secure \? .__Host-taskra_oauth_state. : .taskra_oauth_state./"taskra_oauth_state"/' \
  apps/api/src/github/routes.ts

mutate "37. an API listening beyond this machine does not count as deployed" \
  's/!LOOPBACK_INTERFACES\.has\(config\.API_HOST\) \|\|/false ||/' \
  apps/api/src/config.ts

mutate "38. only named roles are checked, not what the login could write" \
  's/if \(excess\.length === 0 && login\.writes\) \{/if (false) {/' \
  apps/api/src/startup.ts

mutate "39. the API starts although its database login was refused" \
  's/    process\.exit\(1\);\n  \}\n\}\nconst app/  }\n}\nconst app/' \
  apps/api/src/main.ts

mutate "23. the API accepts the attester key on a deployed origin" \
  's/!local\(config\) \|\|/false ||/' \
  apps/api/src/config.ts

if [ "$survivors" -gt 0 ]; then
  echo "RESULT: $survivors of $total mutation(s) not caught"
  exit 1
fi
echo "RESULT: all $total mutations caught"
