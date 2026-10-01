# Taskra

## Verifiable Work. Programmable Payments. Portable Reputation.

**Final Product Specification — Colosseum Hackathon MVP**

> **Amendment notice.** This specification was amended after the Phase-0
> assessment so that it no longer conflicts with `13-DECISIONS.md`, which is
> authoritative for the task lifecycle, fees, disputes, exit paths, evidence rules
> and the deferral of on-chain reliability rewards. Amended passages are marked
> "(amended)".

---

## 1. Executive Summary

Taskra is a Solana-native marketplace for **small, verifiable technical jobs**.

A client posts a task and locks USDC in a Solana escrow. A developer accepts the task, completes the work, and submits verifiable evidence such as a GitHub PR, commit, deployment, or test result. Once the work is approved — or the client fails to respond within the review window — the escrow settles automatically.

The completed settlement becomes a **verified work record** that contributes to the developer's portable reputation.

The core loop is:

> **Identity → Task → Escrow → Work → Evidence → Settlement → Reputation**

Taskra is not trying to be another Upwork clone. The marketplace is the interface; the underlying product is a **trust and settlement protocol for digital work**.

---

# 2. The Problem

Small technical jobs are difficult to transact between strangers.

Example:

> "Fix this Solana transaction bug. I'll pay $50."

The client needs to answer:

- Can this person actually do the work?
- Will they finish on time?
- How can I safely pay a stranger?
- How do I verify that the work was completed?
- What happens if the developer disappears?

The developer faces the opposite problem:

- Is the client serious?
- Will I actually get paid after doing the work?
- What happens if the client disappears?
- How can I prove that I completed this work?
- Can my track record follow me outside one platform?

Traditional marketplaces mostly solve these problems through a centralized platform, centralized reputation, and platform-controlled payment.

Taskra changes the primitive:

> **The work itself becomes evidence, and the settlement becomes part of the reputation.**

---

# 3. Core Insight

A five-star review is weak evidence.

A verified work record is stronger.

Instead of only showing:

> ⭐⭐⭐⭐⭐ Excellent developer

Taskra should eventually show:

- 47 verified tasks completed
- 96% successful settlement rate
- $8,420 successfully settled
- 23 Solana-related tasks
- 18h median delivery time
- 12 distinct clients
- 2 disputed tasks
- 41 verified repository contributions

The important distinction is:

> **Taskra reputation is based primarily on observable work and settlement events, not subjective ratings.**

Reviews can exist later, but they should not be the core reputation primitive.

---

# 4. The Final Product Thesis

Taskra solves one specific problem:

> **How do strangers safely transact around small pieces of technical work when neither side fully trusts the other?**

Taskra combines:

1. **Task escrow**
2. **Verifiable work evidence**
3. **Time-bounded settlement**
4. **Portable work history**
5. **Reliability reputation**

Solana is not decoration. It provides the settlement layer.

---

# 5. Why Solana?

Solana provides product-level advantages for Taskra:

### Programmable escrow

USDC can be locked under a defined task lifecycle instead of relying on a private promise.

### Fast settlement

Small jobs can settle quickly after approval or expiry.

### Low transaction costs

The economics work better for small-value technical jobs.

### USDC

Stablecoin settlement makes the payment amount predictable and enables global digital transactions.

### Portable onchain records

Successful settlements can become independently verifiable work history.

### Machine payments

The same settlement primitive can eventually support autonomous software and AI agents.

The important point is:

> **Taskra uses Solana because payment, settlement, and reputation can become programmable primitives.**

---

# 6. The Task Lifecycle

This is the most important part of the MVP.

(amended) The canonical states and transitions are defined in
`13-DECISIONS.md` §2. In outline:

```text
DRAFT                      (database only)
  ↓  create + fund, atomically
OPEN ───────── client cancels ──────────────→ CANCELLED (full refund)
  ↓  developer accepts
ACCEPTED ───── work deadline missed ────────→ REFUNDED  (full refund)
  ↓  developer submits evidence
SUBMITTED
  ↓  evidence verified
UNDER_REVIEW                (only if the attester option is approved)
  │
  ├── client approves ──────────────────────→ SETTLED
  ├── review window expires ────────────────→ SETTLED
  └── client rejects ──→ DISPUTED ──┬───────→ SETTLED  (payment to developer)
                                    └───────→ REFUNDED (refund to client)

SETTLED
  ↓
VERIFIED WORK RECORD
  ↓
REPUTATION UPDATE
```

`FUNDED`, `APPROVED`, `REVIEW EXPIRES` and `REJECTED` are not states: funding is
part of creation, and the other three are transitions.

### Important correction

The original design gave the client effectively unlimited unilateral power to reject submitted work.

That creates an obvious developer-side failure mode.

The final MVP therefore introduces a **bounded review window**:

> After submission, the client has a fixed review period — for example 48 hours.

Within that period the client can:

- Approve → payment releases.
- Reject → rejection must include a reason/evidence.
- Do nothing → escrow automatically releases after the review window.

This does not solve every dispute problem, but it removes the worst version of the "client disappears forever" problem without requiring a full arbitration protocol.

---

# 7. Core Workflow

## Step 1 — Client Creates a Task

Example:

**Task**

> Build a Solana transaction parser

**Reward**

> 100 USDC

**Deadline**

> 48 hours

**Requirements**

- Rust
- Solana
- Tests
- Documentation

**Acceptance criteria**

- Parses transaction signatures
- Returns structured output
- Includes unit tests
- Includes usage documentation

The acceptance criteria are critical.

Taskra should encourage clients to define **objective deliverables before funding**.

---

# 8. Step 2 — Client Funds Escrow

The client connects a Solana wallet and deposits 100 USDC into the Taskra escrow.

```text
Client Wallet
     │
     │ 100 USDC
     ▼
Taskra Escrow
     │
     │ locked
     ▼
Task funded
```

The client cannot simply withdraw the funds after a developer accepts the task.

---

# 9. Step 3 — Developer Accepts

The developer connects a wallet and views:

- Task requirements
- Reward
- Deadline
- Acceptance criteria
- Client reliability
- Expected evidence

The developer accepts the task.

The acceptance event is recorded.

---

# 10. Step 4 — Developer Submits Evidence

The developer does not merely click:

> "Completed."

They submit evidence.

Possible evidence:

- GitHub PR
- GitHub commit
- Repository
- Deployment URL
- Test output
- Documentation
- Transaction signature

For the hackathon MVP, GitHub should be the primary evidence path.

---

# 11. Step 5 — Verification

Taskra should distinguish between:

### Submitted

The developer claims the work is complete.

### Verified

The submitted work satisfies the defined verification rule.

For the MVP, a strong demo path is:

> **GitHub PR → merged → repository has pre-existing history → task can be marked verified**

This is much stronger than simply accepting a pasted GitHub URL.

However, Taskra should not claim that a merged PR proves the work is objectively correct.

The accurate claim is:

> **Taskra verifies evidence of completed work against predefined conditions.**

Deep semantic verification can be added later.

---

# 12. Step 6 — Settlement

If the client approves (amended to show the 2.5% fee):

```text
Taskra Escrow (100 USDC)
      ├── 97.50 USDC → Developer Wallet
      └──  2.50 USDC → Taskra Treasury
```

If the client does not respond before the review window expires:

```text
Review Window Expires
        ↓
Automatic Settlement
        ↓
Developer Wallet
```

If the client rejects:

```text
Rejected
   ↓
Evidence + reason recorded
   ↓
Dispute state
```

For the hackathon MVP, dispute resolution can be represented by a controlled platform resolution mechanism rather than pretending Taskra has a fully decentralized arbitration system.

(amended) A rejection moves the task directly to `DISPUTED`. The platform
authority has exactly two outcomes — full refund to the client, or full payment to
the developer (minus the fee) — and a permissionless timeout fallback prevents
funds from being locked if the platform is unavailable. The client can also cancel
before acceptance and take a refund if the work deadline is missed. See
`13-DECISIONS.md` §2 and §8.

**Do not build a fake "decentralized dispute court" just for the pitch.**

---

# 13. Step 7 — Reputation

After successful settlement, Taskra creates a verified work record.

Example:

```text
Developer: 7xDev

Verified Work
────────────────────────────
Tasks completed:       47
Successful settlements: 45
Success rate:          95.7%
Total settled:         $8,420
Distinct clients:      12
Solana tasks:          23
Disputes:               2
Median delivery:      18h
```

The important data comes from actual Taskra activity.

---

# 14. Reliability Reputation

The second proposal introduced the **Developer Reliability Bonus (DRB)** to address a genuine problem: the original MVP placed too much execution risk on developers and had weak incentives for sustained supply.

The underlying insight is correct.

The original implementation, however, is too complicated for the hackathon and has economic weaknesses.

### Problems with the original DRB design

#### 1. The formula is over-engineered for MVP

A weighted mathematical score is unnecessary when the platform has very little data.

#### 2. "Distinct clients" does not prove independent clients

Wallet addresses are not real-world identity.

A determined attacker can create multiple wallets.

Taskra should therefore claim **Sybil resistance**, not Sybil-proof identity.

#### 3. A platform-funded bonus can become a liability

If rewards are promised before sufficient fee revenue exists, the platform creates an unfunded obligation.

#### 4. The reward itself can distort behavior

Developers may optimize for qualifying tasks rather than genuinely valuable work.

---

# 15. Final Reliability System

Instead of launching a complicated DRB formula, Taskra should launch a simpler **Reliability Score + capped Reliability Rewards** model.

## Reliability Score

For the MVP:

```text
Reliability Score =
successful verified tasks
+ distinct-client bonus
+ timely-completion bonus
− dispute penalty
```

The score is intentionally transparent.

The first version should prioritize:

- successful settlements
- distinct clients
- on-time delivery
- dispute history

Not dozens of opaque variables.

---

# 16. Reliability Rewards

The reward should NOT be a guaranteed permanent liability.

Instead:

> A fixed percentage of collected Taskra fees is allocated to a Reliability Rewards pool.

Example:

```text
100 USDC task

2.5 USDC Taskra fee
       │
       ├── Platform operations
       │
       └── Reliability Rewards reserve
```

The reward pool has a hard cap per epoch.

Therefore:

> **Taskra can never distribute more reliability rewards than the reserve allows.**

This makes the mechanism economically bounded.

---

# 17. MVP Reliability Reward

> (amended) **On-chain reliability rewards are deferred from the MVP.** There is
> no reward payout, reward reserve or reward instruction. The Reliable
> Contributor milestone below is computed off-chain, displayed with the label
> "Off-chain aggregate", and must never imply that an on-chain reward was
> distributed. Sections 16 and 17 describe the intended future mechanism.

Do not implement the full scoring formula during the hackathon.

Use one visible milestone:

> **Reliable Contributor**

Example qualification:

- 3 successfully settled tasks
- from 3 distinct clients
- minimum task value
- completed within deadline
- no unresolved disputes

Then award a small reward from the existing Reliability Rewards reserve.

The reward should be presented as:

> **a protocol incentive for demonstrated reliability**

not:

> guaranteed income.

This distinction matters.

---

# 18. The Reputation Flywheel

Taskra's real growth loop is:

```text
More clients
     ↓
More tasks
     ↓
More completed work
     ↓
More verified evidence
     ↓
Better reputation data
     ↓
Lower hiring uncertainty
     ↓
More clients
```

On the supply side:

```text
Verified work
     ↓
Higher reliability
     ↓
Better visibility
     ↓
More opportunities
     ↓
More developers join
```

The reliability reward reinforces this loop without becoming the product itself.

---

# 19. What Taskra Is NOT

Do not turn Taskra into:

- Fiverr
- Upwork
- a social network
- a DAO
- a token speculation platform
- an NFT marketplace
- an AI wrapper
- a generic bounty board
- a complex decentralized court

The positioning should remain:

> **Trust and settlement infrastructure for verifiable digital work.**

---

# 20. The AI Angle

AI is important — but it should remain a **future extension**, not the MVP.

The wrong pitch:

> "Taskra is an AI-powered freelance marketplace."

That sounds replaceable.

The stronger thesis:

> **Taskra creates the economic rails through which both humans and software agents can transact around verifiable work.**

Today:

```text
Human
  ↓
Taskra
  ↓
Human Developer
```

Future:

```text
Human
  ↓
Taskra
  ↓
AI Agent
```

Eventually:

```text
Agent
  ↓
Taskra
  ↓
Agent
  ↓
Human
```

The same escrow, evidence, settlement, and reputation primitives can support all three.

---

# 21. The Killer Demo

The entire hackathon presentation should revolve around **one real task**.

## 0:00 — Problem

Show:

> "I need a Solana developer to fix this bug. I'll pay $100."

Then show the trust problem.

---

## 0:30 — Create Task

Client creates:

> Build a Solana transaction parser

Reward:

> 100 USDC

Deadline:

> 48 hours

The client funds the escrow.

**Show the actual Solana transaction.**

---

## 1:15 — Developer

Developer discovers the task.

They see:

- reward
- deadline
- acceptance criteria
- client history

They accept.

---

## 1:45 — Work

Developer submits a GitHub PR.

Show the actual repository / PR.

---

## 2:15 — Verification

Show the evidence.

(amended)

```text
PR merged by someone other than its author
✓
PR targets the repository named in the task
✓
Repository existed before the task was created
✓

Tests passed (informational — not a verification condition)
```

---

## 2:40 — Settlement

Client approves.

Then show (amended to include the 2.5% fee):

```text
100 USDC escrow
       ├── 97.50 USDC → Developer Wallet
       └──  2.50 USDC → Taskra Treasury
```

Show the Solana transaction.

---

## 3:00 — Reputation

Developer profile updates:

```text
47 → 48 verified tasks
95.7% → 95.9% success
Distinct clients: 12 → 13
```

---

## 3:20 — Reliability

Show:

> Reliable Contributor

(amended) The developer crosses the milestone. It is shown with the label "Off-chain aggregate". No on-chain reward is distributed in the MVP.

---

## 3:40 — Future

Show:

```text
Human → Taskra → Developer

                ↓

Human → Taskra → AI Agent
```

Closing statement:

> **"Today Taskra helps strangers transact around technical work. Tomorrow, the same infrastructure can let humans and AI agents transact around digital work."**

---

# 22. MVP Feature Set

## Client

- Connect Solana wallet
- Create task
- Define acceptance criteria
- Set reward
- Fund escrow
- View submissions
- Approve / reject
- View settlement transaction
- View client reputation

## Developer

- Connect wallet
- Developer profile
- Browse tasks
- View task details
- Accept task
- Submit evidence
- Track review status
- Receive USDC
- View verified work history
- View Reliability Score

## Onchain

- Task account
- Escrow state
- USDC deposit
- Task acceptance
- Submission/settlement state
- USDC release
- Basic verified-work record

(amended) Reliability reward distribution is deferred from the MVP.

## Offchain

- Task metadata
- GitHub integration
- Evidence metadata
- Repository/PR verification
- Search and filtering
- Profile aggregation

---

# 23. What Goes Onchain vs Offchain

This distinction is important.

## Onchain

Store the minimum economically important state:

- task ID
- client wallet
- developer wallet
- escrow amount
- task status
- deadlines
- settlement
- evidence hash/reference
- reputation-relevant settlement event

## Offchain

Store heavier data:

- task description
- acceptance criteria
- GitHub metadata
- PR details
- test output
- UI data
- search indexes

Do not put entire GitHub content or large task descriptions onchain.

---

# 24. Smart Contract Design

The MVP should use **one primary Task/Escrow program**.

Conceptually (amended; the instruction set is defined in `13-DECISIONS.md` §3.9):

```text
create_task()      creates and funds atomically
      ↓
accept_task()
      ↓
submit_work()
      ↓
approve_task()     releases payment in the same instruction
```

Additional state transitions:

```text
expire_review()
reject_task()      moves directly to DISPUTED
resolve_dispute()
expire_dispute()
cancel_task()
refund_task()
```

The exact instruction set should be kept minimal.

The contract should enforce:

- only the client can fund their task
- only an accepted developer can submit
- only valid state transitions are allowed
- escrow cannot be released twice
- deadlines are enforced
- settlement amount is deterministic

---

# 25. Architecture

```text
                    ┌─────────────────┐
                    │      CLIENT     │
                    └────────┬────────┘
                             │
                       Create / Fund
                             │
                             ▼
                    ┌─────────────────┐
                    │     TASKRA      │
                    │   WEB APP/API   │
                    └────────┬────────┘
                             │
                   Transaction request
                             │
                             ▼
                    ┌─────────────────┐
                    │     SOLANA      │
                    │ TASK / ESCROW   │
                    └────────┬────────┘
                             │
                           Accept
                             │
                             ▼
                    ┌─────────────────┐
                    │    DEVELOPER    │
                    └────────┬────────┘
                             │
                        Work + Evidence
                             │
                             ▼
                    ┌─────────────────┐
                    │     GITHUB      │
                    └────────┬────────┘
                             │
                       Verification
                             │
                             ▼
                    ┌─────────────────┐
                    │     TASKRA      │
                    │   SETTLEMENT    │
                    └────────┬────────┘
                             │
                        USDC Release
                             │
                             ▼
                    ┌─────────────────┐
                    │   REPUTATION    │
                    └─────────────────┘
```

---

# 26. Recommended Technical Stack

### Frontend

- React
- TypeScript
- Tailwind CSS
- Solana wallet integration

### Backend

- Node.js
- TypeScript
- PostgreSQL

### Solana

- Rust
- Anchor
- SPL USDC

### Work verification

- GitHub API

### Hosting

Use the team's existing web deployment stack.

The exact infrastructure is less important than making the complete transaction flow reliable.

---

# 27. Business Model

Taskra charges a small transaction fee.

Example:

```text
$100 task
   ↓
2.5% fee
   ↓
$97.50 developer
```

A portion of collected fees can fund the Reliability Rewards reserve.

Future revenue:

- enterprise hiring
- API access
- verification services
- reputation APIs
- agent infrastructure
- B2B integrations

Do not build these during the hackathon.

---

# 28. Long-Term Product Roadmap

## Phase 1 — Human → Human

Technical micro-jobs.

```text
Client → Developer
```

## Phase 2 — Verifiable Reputation

Portable work history becomes the central identity layer.

```text
Work → Evidence → Settlement → Reputation
```

## Phase 3 — Human → AI

Clients can hire software agents for bounded tasks.

```text
Client → AI Agent
```

## Phase 4 — Machine Economy

Agents discover and execute tasks programmatically.

```text
Agent
  ↓
Taskra
  ↓
Agent
  ↓
Human
```

Taskra becomes a coordination and settlement layer for digital labor.

---

# 29. Competitive Positioning

Do NOT say:

> "Taskra is decentralized Upwork."

Say:

> **"Taskra is a trust and settlement layer for verifiable digital work."**

The marketplace is only the first interface.

The underlying primitives are:

```text
IDENTITY
   +
TASK
   +
ESCROW
   +
EVIDENCE
   +
SETTLEMENT
   +
REPUTATION
```

That is the actual product.

---

# 30. Why This Is Stronger Than the Original Idea

The original Taskra concept had a strong core but several weaknesses.

### Weakness 1 — Client-side power imbalance

**Fixed:** bounded review window + automatic settlement on timeout.

### Weakness 2 — "Verification" was vague

**Fixed:** define evidence and verification conditions explicitly.

### Weakness 3 — Reputation could be gamed

**Fixed:** reputation emphasizes distinct clients, settlement, timing, and disputes rather than raw completion count.

### Weakness 4 — DRB was too complicated

**Fixed:** transparent Reliability Score for MVP; sophisticated weighting comes later.

### Weakness 5 — DRB treasury risk

**Fixed:** rewards are funded from a capped fee-derived reserve.

### Weakness 6 — Overclaiming Sybil resistance

**Fixed:** Taskra treats wallet-level independence as an imperfect signal and does not claim identity-level Sybil-proofness.

### Weakness 7 — Too much future vision in the MVP

**Fixed:** AI remains a future extension while the demo focuses on one complete human-to-human transaction.

---

# 31. What We Absolutely Should NOT Build

Cut these unless the core workflow is already flawless:

- DAO
- Governance token
- NFT system
- Tokenomics
- Mobile app
- Social feed
- Chat system
- AI marketplace
- AI agent framework
- Complex recommendation engine
- Full arbitration protocol
- Multi-chain support
- Dozens of smart contracts
- Complex reputation mathematics
- Full Fiverr/Upwork feature set

The rule:

> **One complete economic loop beats thirty half-built features.**

---

# 32. The Real Hackathon Moat

The moat is not:

> "We use Solana."

Everyone in the hackathon can use Solana.

The interesting part is the mechanism:

> **Work produces evidence.  
> Evidence produces settlement.  
> Settlement produces reputation.  
> Reputation reduces future trust costs.**

That is the loop worth demonstrating.

---

# 33. Success Criteria for the MVP

Before submission, Taskra should be able to demonstrate all of this without manually faking the critical steps:

### Client

- Connect wallet
- Create task
- Fund escrow

### Developer

- Discover task
- Accept task
- Submit evidence

### Protocol

- Track task state
- Verify evidence conditions
- Enforce review deadline
- Release USDC

### Reputation

- Record successful settlement
- Update developer profile
- Update reliability metrics

### Blockchain proof

At least the following should be visibly real on Solana:

> **Escrow funding → settlement → developer payment**

If the judge can inspect the transaction on-chain, the blockchain component becomes undeniable.

---

# 34. One-Sentence Pitch

> **Taskra is a Solana-native trust and settlement layer for technical work, where clients escrow USDC, developers prove completed work with verifiable evidence, and successful settlements build portable reputation.**

---

# 35. 30-Second Pitch

> **"Taskra lets strangers safely transact around technical work. A client posts a task and locks USDC in a Solana escrow. A developer accepts it, completes the work, and submits verifiable evidence such as a GitHub PR. Once the work is approved — or the review window expires — the escrow settles automatically, and that successful transaction becomes part of the developer's reputation. We are not building another Upwork. We're building the trust and settlement layer for verifiable digital work — eventually for both humans and AI agents."**

---

# 36. Final Product Decision

## Product

**Taskra**

## Category

**Verifiable digital-work marketplace / trust and settlement infrastructure**

## Core MVP

```text
Human Client
     ↓
Technical Task
     ↓
USDC Escrow on Solana
     ↓
Developer
     ↓
GitHub Evidence
     ↓
Verification
     ↓
Settlement
     ↓
Verified Reputation
```

(amended) The on-chain Reliability Reward is deferred from the MVP.

## Core differentiator

> **Reputation comes from verifiable work and economic settlement, not merely reviews.**

## Solana's role

> **Escrow + settlement + portable economic records**

## AI's role

> **Future worker category, not the MVP product**

## Hackathon strategy

> **Build one complete, real economic workflow. Make every important blockchain action real. Cut everything else.**

---

# 37. Final Rule

Do not build Taskra to impress judges with complexity.

Build it so that a judge can perform this sequence:

```text
Connect Wallet
      ↓
Create Task
      ↓
Fund Escrow
      ↓
Accept Task
      ↓
Submit Real Evidence
      ↓
Approve
      ↓
USDC Moves Onchain
      ↓
Reputation Changes
```

Then ask:

> **"If two strangers can safely do this with $100 today, what happens when millions of digital tasks — including tasks performed by AI agents — need the same economic infrastructure?"**

That is Taskra.
