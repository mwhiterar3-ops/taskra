# Taskra — Hackathon Demo Specification

The demo should be 3–4 minutes and revolve around ONE real task.

Example:
Task: Build a Solana transaction parser
Reward: 100 USDC
Deadline: 48 hours

## Sequence

0:00 — Problem
Show the trust/payment problem.

0:30 — Client
Create task and fund escrow with 100 USDC.

1:15 — Developer
Discover and accept task.

1:45 — Work
Submit a real GitHub PR/evidence.

2:15 — Verification
Show explicit verification conditions (see `13-DECISIONS.md` §10):
PR merged by someone other than its author, into the repository named in the
task, which existed before the task was created.
CI/test status may be shown, labelled "informational — not a verification
condition".

2:40 — Settlement
Client approves.
Show the actual Solana transaction and USDC movement, including the 2.5% fee:

- Escrow: 100.00 USDC
- Developer receives: 97.50 USDC
- Taskra treasury receives: 2.50 USDC

3:00 — Reputation
Show verified work record and updated reputation.
If the Reliable Contributor milestone is shown, label it "Off-chain aggregate".
No on-chain reliability reward is distributed in the MVP, and the demo must not
imply one.

3:20 — Future
Briefly explain human→AI as a future extension.

Do not fake the critical blockchain actions.
Do not add new features for the demo.
