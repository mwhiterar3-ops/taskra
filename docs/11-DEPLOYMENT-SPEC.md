# Taskra — Deployment Specification

Development:
- Solana Devnet
- local PostgreSQL or configured hosted PostgreSQL
- local frontend/API

Production/demo:
- deploy web
- deploy API
- configure database
- configure GitHub OAuth/API
- deploy Anchor program to target Solana network
- verify program ID and configuration
- verify USDC mint configuration
- run migrations
- run smoke tests

The final deployed system must not depend on local filesystem state.

Before demo:
1. Create/fund a real test task.
2. Execute developer acceptance.
3. Submit real-shaped GitHub evidence.
4. Verify evidence.
5. Approve.
6. Confirm USDC settlement.
7. Confirm reputation update.
8. Save transaction signatures for the demo.
