# Taskra — GitHub Verification Specification

GitHub is the primary evidence path for the MVP. A GitHub pull request is the only
MVP evidence type.

A pasted GitHub URL is NOT automatically verified.

## Evidence object

At minimum capture:
- evidence type
- repository URL
- PR URL / number when applicable
- PR head commit SHA
- submitter wallet
- connected GitHub identity
- submitted timestamp

## Evidence hash

`evidence_hash = SHA-256("taskra:evidence:v1" || LP(repo) || LP(pr_number) || LP(head_sha))`

where `LP(x)` is the byte length of `x` as a 4-byte big-endian integer followed by
`x`. The exact field formats and published test vectors are in `13-DECISIONS.md`
§5.2 and §10.3. `head_sha` replaces `merge_commit_sha`: every pull request has a
head SHA, merged or not.

The developer records this hash on-chain with `submit_work`. The program accepts
any non-zero 32 bytes; the hash authorizes nothing by itself. Money moves only
through an attestation bound to the task, the hash and the submission nonce, or
through the client's approval or the authority's decision.

## MVP verification

The authoritative rule table is `13-DECISIONS.md` §10. The verifier fetches the
pull request from GitHub and attests only if all of the following hold:

1. URL is a valid GitHub pull request.
2. The PR targets exactly the repository specified by the task at creation.
3. Repository exists and its `created_at` is earlier than the Taskra task creation timestamp. This is the definition of "pre-existing history".
4. Pull request exists and is merged.
5. PR author matches the connected GitHub identity.
6. `merged_by` differs from the PR author. A self-merge is REJECTED.
7. Merge timestamp is after task acceptance.
8. Merge timestamp is at or before the work deadline.
9. The evidence hash recomputed from GitHub's own data — the task's repository, the PR number and the merged PR's final head SHA — equals the hash recorded on the Task account. The verifier never trusts a hash or head SHA supplied in a request.
10. Verification result is persisted with an auditable reason per rule.

CI/test status is informational only. It is NOT a verification condition.

Use explicit VERIFIED / REJECTED / PENDING states.

## Lifecycle

- **Merged PR.** The head SHA is final. If the submitted hash matches, the
  attester records the attestation on-chain and the review window starts.
- **Unmerged PR.** Rule 4 fails: no attestation is recorded and the task stays
  `SUBMITTED`. The developer-dispute path applies (`13-DECISIONS.md` §2.4).
- **Later commits.** A new commit changes the head SHA, so the old hash no longer
  matches. The developer must resubmit, which starts a new submission nonce and
  voids any earlier attestation.
- **Arbitrary hash.** A hash of anything else can never match and is never
  attested. It can only delay the client's refund, never produce a payment
  (`13-DECISIONS.md` §2.7).

## Claims

Do not claim that a merged PR proves objective correctness. Taskra verifies evidence against predefined conditions.

## Failures

GitHub API failures must become PENDING and remain retryable. They must never
become VERIFIED.
