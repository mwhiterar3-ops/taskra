#!/usr/bin/env bash
# Mutation check for the Taskra program.
#
# Seeds one defect at a time into programs/taskra/src, rebuilds, runs the whole
# test suite and reports how many tests fail. Every mutation must be caught (at
# least one failing test); each is reverted with git before the next one.
#
# Usage: scripts/mutation-check.sh        (from the repository root, clean tree)
set -u
cd "$(dirname "$0")/.." || exit 1

SRC=programs/taskra/src
if ! git diff --quiet -- "$SRC"; then
  echo "error: $SRC has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

survivors=0

# mutate <name> <perl substitution> <file>...
mutate() {
  local name="$1" substitution="$2"
  shift 2
  perl -0pi -e "$substitution" "$@"
  if git diff --quiet -- "$SRC"; then
    echo "MUTATION '$name': pattern not found, nothing was changed"
    survivors=$((survivors + 1))
    return
  fi
  if ! anchor build >/tmp/taskra-mutation-build.log 2>&1; then
    echo "MUTATION '$name': does not compile (see /tmp/taskra-mutation-build.log)"
    survivors=$((survivors + 1))
  else
    cargo test --workspace --no-fail-fast >/tmp/taskra-mutation-test.log 2>&1
    local failed
    failed=$(grep -c '\.\.\. FAILED$' /tmp/taskra-mutation-test.log)
    if [ "$failed" -gt 0 ]; then
      echo "MUTATION '$name': CAUGHT by $failed tests, e.g."
      grep '\.\.\. FAILED$' /tmp/taskra-mutation-test.log | head -3 | sed 's/^/    /'
    else
      echo "MUTATION '$name': SURVIVED"
      survivors=$((survivors + 1))
    fi
  fi
  git checkout -- "$SRC"
}

mutate "1. expire_review allowed at the review deadline" \
  's/now > task\.review_deadline/now >= task.review_deadline/' \
  "$SRC/instructions/review.rs"

mutate "2. approval does not record its outcome" \
  's/Outcome::Approved,/Outcome::None,/' \
  "$SRC/instructions/review.rs"

mutate "3. attestation accepts an older nonce" \
  's/submission_nonce == task\.submission_nonce/submission_nonce <= task.submission_nonce/' \
  "$SRC/instructions/attest.rs"

mutate "4. dispute fallback always pays the developer" \
  's/if task\.has_valid_attestation\(\) \{/if true {/' \
  "$SRC/instructions/dispute.rs"

mutate "5. fee rounds up instead of down" \
  's/\.checked_mul\(u128::from\(fee_bps\)\)/.checked_mul(u128::from(fee_bps)).map(|p| p + 9_999)/' \
  "$SRC/fees.rs"

mutate "6. terminal state not written after the transfer" \
  's/task\.state = state;/let _ = state;/' \
  "$SRC/settlement.rs"

mutate "7. mint taken from the passed account instead of the Platform" \
  's/#\[account\(address = platform\.usdc_mint\)\]\n\s*//g' \
  "$SRC/instructions/create.rs" "$SRC/instructions/review.rs" \
  "$SRC/instructions/refund.rs" "$SRC/instructions/dispute.rs"

mutate "8. submission nonce not bumped on resubmission" \
  's/\.checked_add\(1\)/.checked_add(u64::from(task.submission_nonce == 0))/' \
  "$SRC/instructions/submit.rs"

mutate "9. work_duration has no upper bound" \
  's/work_duration > 0 && work_duration <= MAX_WORK_DURATION/work_duration > 0/' \
  "$SRC/instructions/create.rs"

mutate "10. platform windows have no upper bound" \
  's/window > 0 && window <= MAX_WINDOW/window > 0/' \
  "$SRC/instructions/platform.rs"

# Leave the build output matching the committed sources again.
anchor build >/tmp/taskra-mutation-build.log 2>&1 || echo "warning: final rebuild failed"

if [ "$survivors" -gt 0 ]; then
  echo "RESULT: $survivors mutation(s) not caught"
  exit 1
fi
echo "RESULT: all 10 mutations caught"
