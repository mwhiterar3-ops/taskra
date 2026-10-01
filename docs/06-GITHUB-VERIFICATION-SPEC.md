# Taskra — GitHub Verification Specification

GitHub is the primary evidence path for the MVP. A GitHub pull request is the only
MVP evidence type.

A pasted GitHub URL is NOT automatically verified.

## Evidence object

At minimum capture:
- evidence type
- repository URL
- PR URL / number when applicable
- submitter wallet
- connected GitHub identity
- submitted timestamp

## MVP verification

The authoritative rule table is `13-DECISIONS.md` §10. Verify:

1. URL is a valid GitHub pull request.
2. The PR targets exactly the repository specified by the task at creation.
3. Repository exists and its `created_at` is earlier than the Taskra task creation timestamp. This is the definition of "pre-existing history".
4. Pull request exists and is merged.
5. PR author matches the connected GitHub identity.
6. `merged_by` differs from the PR author. A self-merge is REJECTED.
7. Merge timestamp is after task acceptance.
8. Merge timestamp is at or before the work deadline.
9. Verification result is persisted with an auditable reason per rule.

CI/test status is informational only. It is NOT a verification condition.

Use explicit VERIFIED / REJECTED / PENDING states.

## Evidence hash

`SHA-256(canonical JSON({repo, pr_number, merge_commit_sha}))`

The canonical serialization is defined in `13-DECISIONS.md` §10.3 so the same
evidence always produces the same hash.

## Claims

Do not claim that a merged PR proves objective correctness. Taskra verifies evidence against predefined conditions.

## Failures

GitHub API failures must become PENDING and remain retryable. They must never
become VERIFIED.
