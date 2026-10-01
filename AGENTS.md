# Taskra — Agent Engineering Rules

1. Read `/docs` before modifying architecture.
2. Do not invent product requirements.
3. Do not expand MVP scope.
4. Never fake critical blockchain behavior in production.
5. Never store user private keys or seed phrases. No privileged backend signing key exists unless approved in `docs/13-DECISIONS.md` with a documented security model.
6. Never commit secrets.
7. Treat Solana as authoritative for financial settlement.
8. Keep monetary values in integer token base units.
9. Use explicit state machines.
10. Every critical mutation must be authorized and validated.
11. Every critical feature requires tests.
12. Do not claim completion because code merely exists.
13. Keep the application deployable after each phase.
14. Prefer the smallest implementation consistent with the specifications.
15. Avoid unnecessary abstractions and services.
16. If ambiguity affects money, security, or architecture, stop and report it before implementing.
17. Do not silently change the product specification.
18. Use real transaction signatures in the demo.
19. Never make a UI success state contradict the underlying blockchain state.
20. At the end of each phase, report completed work, tests, files changed, decisions, limitations, and next phase.
