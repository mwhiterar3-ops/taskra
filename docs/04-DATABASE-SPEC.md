# Taskra — Database Specification

Use PostgreSQL with migrations.

Minimum logical entities:

- users
- wallets
- tasks
- task_metadata
- task_evidence
- github_accounts
- github_repositories
- github_pull_requests
- verification_results
- settlements
- reputation_snapshots
- disputes
- onchain_transactions

`reliability_rewards` was removed: on-chain reliability rewards are deferred from
the MVP (`13-DECISIONS.md` D15). The Reliable Contributor milestone is an off-chain
aggregate derived from `reputation_snapshots`.

Exact schema, keys, indexes, constraints and relations must be written before implementation.

Task state names are those in `13-DECISIONS.md` §2. The task primary key is the
UUID defined in `13-DECISIONS.md` §5.

## Rules

- wallet addresses must be uniquely indexed where appropriate
- task IDs must be stable and correlate with onchain identifiers
- monetary values use integer base units
- timestamps use UTC
- settlement records must include transaction signatures when available
- a settlement is authoritative only once its transaction is `finalized` (`13-DECISIONS.md` §11)
- verification records must be auditable
- migrations are mandatory
- no manual production schema mutation

## Idempotency

Blockchain indexing and webhook/event processing must tolerate retries without creating duplicate settlement or reputation records.
