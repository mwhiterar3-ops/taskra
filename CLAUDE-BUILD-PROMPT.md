# Taskra — Claude Code Build Prompt

You are the principal engineer implementing Taskra.

Read every file under `/docs` and `/AGENTS.md` before coding.

Do not start by writing application code.

First:
1. inspect the repository
2. inspect existing files and dependencies
3. read the complete specification pack
4. produce a concise architecture and phased implementation plan
5. identify ambiguities that materially affect money, security, or architecture
6. resolve non-critical ambiguities using the smallest reasonable implementation

Then implement in phases:

Phase 0 — repository/toolchain
Phase 1 — Anchor program
Phase 2 — SDK
Phase 3 — database/API
Phase 4 — GitHub verification
Phase 5 — frontend
Phase 6 — integration
Phase 7 — E2E/demo hardening

Do not move to the next phase while the previous critical tests are failing.

The critical economic workflow must be real:

Client
→ Create Task
→ Fund USDC escrow on Solana
→ Developer Accepts
→ Developer Submits GitHub Evidence
→ Taskra Verifies Evidence
→ Client Approves OR Review Expires
→ Escrow Settles
→ Developer Receives USDC
→ Reputation Updates

No fake blockchain transactions in production.

Do not add DAO/token/NFT/social/chat/AI-agent/multi-chain/complex-arbitration functionality.

For every phase report:
- completed
- tests run
- files changed
- decisions
- known limitations
- next phase

Definition of done:

A fresh user can complete the entire economic loop on the configured network, and a judge can inspect the real Solana settlement transaction.

If a requirement concerning money movement, security, or architecture is ambiguous, stop and ask rather than inventing a complex mechanism.
