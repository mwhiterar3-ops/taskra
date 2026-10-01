# Taskra — API Specification

The API must expose only the operations required by the MVP.

Suggested surface:

GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:id
POST /api/tasks/:id/fund
POST /api/tasks/:id/accept
POST /api/tasks/:id/evidence
GET  /api/tasks/:id/verification
POST /api/tasks/:id/approve
POST /api/tasks/:id/reject
GET  /api/users/:wallet
GET  /api/users/:wallet/reputation

For every mutation define:
- authentication
- authorization
- request schema
- response schema
- validation
- errors
- idempotency
- side effects

Never report a critical blockchain mutation as successful before the configured confirmation policy is satisfied.

The confirmation policy is defined in `13-DECISIONS.md` §11: `confirmed` for UI
progress, `finalized` before a financial settlement is recorded as authoritative.

The API never signs or sends a user's transaction. The mutation endpoints above
that correspond to on-chain instructions (`fund`, `accept`, `approve`, `reject`)
receive the signature of a transaction the user's wallet already sent, and record
its effect only after reading it from Solana. Task creation and funding are one
atomic on-chain operation (`13-DECISIONS.md` §4).

Task state names are those in `13-DECISIONS.md` §2.
