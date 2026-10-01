# Taskra — Offchain Architecture Specification

## Responsibilities

Offchain systems handle:

- task descriptions
- acceptance criteria
- GitHub metadata
- evidence metadata
- verification results
- search/filtering
- profile aggregation
- UI data
- indexing of onchain events

## Source of truth

Solana is authoritative for:
- escrow
- economically relevant task state
- settlement
- token movement
- onchain records

PostgreSQL is authoritative for:
- application metadata
- GitHub verification metadata
- search indexes
- cached profile aggregation

Never let a database-only flag claim that funds were settled when the blockchain disagrees.

## Architecture

Prefer a simple monorepo:
- web
- api
- worker only if genuinely required
- Anchor program
- shared/sdk packages

Do not introduce unnecessary microservices.
