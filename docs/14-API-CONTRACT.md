# Taskra — API Contract (boundaries)

This document fixes who is responsible for what between the SDK, the API, the
database, GitHub and Solana. It defines boundaries only; the API itself is
Phase 3 and is not implemented yet. Endpoint shapes remain in `05-API-SPEC.md`.

## 1. Layers

| Layer | Is | Is not |
|---|---|---|
| Solana program | The final authority on escrow, task state, deadlines, fees and settlement. | Aware of GitHub, task text or users. |
| SDK (`packages/sdk`) | A pure library: addresses, unsigned instructions, account decoding, hashes, fee and timeline arithmetic, error decoding. Used by both the web app and the API. | A signer, a key holder, an authorizer, or a source of truth. |
| API (`apps/api`) | The owner of off-chain metadata, GitHub verification and cached aggregates; an observer of the chain. | A custodian of funds or user keys, or a party to any settlement. |
| Web (`apps/web`) | The place where a user's wallet approves transactions. | Trusted by the API or the program for anything. |

## 2. SDK → API responsibilities

The API uses the SDK for, and only for:

- deriving the Task address from `(client wallet, task UUID)` and reading the
  Task and Platform accounts (`fetchTask`, `fetchPlatform`), always passing an
  explicit commitment;
- computing `terms_hash` and `evidence_hash` (the SDK's TypeScript
  implementation is canonical) and comparing them with on-chain values;
- describing a task to clients: state, `computeTimeline`, `hasValidAttestation`,
  `computeFee`;
- decoding program errors into typed names;
- building the one instruction the API's attestation service sends,
  `record_attestation`.

SDK helpers report facts. A helper returning `true` never authorizes anything:
the program re-checks every condition.

## 3. API → Solana responsibilities

- **The API never signs or sends a user's transaction.** The browser builds it
  with the SDK, the user's wallet approves and sends it, and the browser reports
  the signature to the API.
- For a reported signature the API does not trust the report. It fetches the
  transaction and the Task account from its own RPC endpoint and derives the
  effect from them. A signature for a different program, task or instruction is
  rejected.
- The API may send permissionless instructions (`expire_review`,
  `expire_dispute`) only if a later phase explicitly decides to run a keeper. No
  worker exists today; anyone, including the developer, can send them.
- The only transaction the API's side ever signs is `record_attestation`, with
  the attester key, from the attestation service (§6).
- Idempotency: every chain observation is keyed by transaction signature, so a
  repeated report or a retry cannot create a second settlement or reputation
  record.

## 4. Wallet authentication boundary

- A wallet address in a request body proves nothing. Identity is established
  only by a signature over a server-issued, single-use, short-lived nonce bound
  to the API's domain, which yields a session.
- That signature is a message signature for login. It is never a transaction,
  and the session it creates cannot move funds: funds move only through
  transactions the wallet itself approves.
- API authorization is role-by-state: the session wallet must equal the task's
  on-chain `client` or `developer` for client-only or developer-only metadata
  operations. This protects metadata; it does not replace the program's own
  signer checks.

## 5. Database authority boundary

| Data | Authority | The other side's role |
|---|---|---|
| Task existence after funding, `client`, `developer`, `amount`, `fee_bps`, state, outcome, all deadlines, `submission_nonce`, `evidence_hash`, attestation fields, `terms_hash` | **On-chain Task account** | The database caches them for search and display, tagged with the commitment and slot they were read at. On any disagreement the chain wins and the cache is rewritten. |
| Fee rate, time windows, authority, attester, treasury, mint | **On-chain Platform account** | Cached only. |
| USDC balances and token movements | **Solana** | Never stored as a balance. A settlement row records how the task's amount was divided, and only when the outcome instruction's own transfers bear it out (`13-DECISIONS.md` §17.4). |
| Draft tasks (before funding) | **Database** | Not visible on-chain. A draft becomes a task only when its Task account exists. |
| Title, description, acceptance criteria, target repository | **Database**, bound to the chain by `terms_hash` | The API recomputes `terms_hash` from stored metadata; if it differs from the on-chain value the metadata is shown as unverified and is never used for verification. |
| GitHub identity links, PR metadata, verification results, rejection reason text | **Database** | The chain holds only hashes (`evidence_hash`, `rejection_reason_hash`). |
| Reputation aggregates, "Reliable Contributor" (off-chain aggregate) | **Database**, derived from finalized Task accounts | Recomputable from chain at any time. |

No database flag may claim that funds were settled, refunded or escrowed. Those
facts are read from the chain.

## 6. GitHub verification boundary

- Only the verifier talks to GitHub. It never trusts a hash, head SHA,
  repository or PR author supplied in a request; it fetches them and recomputes
  `evidence_hash` itself (`13-DECISIONS.md` §10).
- The verifier's output is one decision per submission: VERIFIED, REJECTED or
  PENDING. Only VERIFIED leads to an on-chain action, and that action is exactly
  one `record_attestation` for the task's current `evidence_hash` and
  `submission_nonce`.
- A GitHub failure is PENDING and retryable. It never becomes VERIFIED.
- **Phase 4 requirements, recorded now:**
  - The verifier's audit record stores **both** `head_sha` and
    `merge_commit_sha` for every verified pull request, together with the PR
    author, `merged_by`, the merge timestamp, the rule results and the
    attestation transaction signature. Only `head_sha` enters the evidence hash;
    `merge_commit_sha` is kept so the merge can be audited later.
  - **The attester key never runs inside the web process**, and is never
    reachable from request-handling code. It lives in a separate attestation
    service with its own secret store, accepts work only from the verifier, and
    can produce nothing but `record_attestation`.

## 7. Confirmation and finality

| Commitment | Meaning for the UI | Meaning for the API and database |
|---|---|---|
| submitted, not confirmed | "Submitted". Never shown as success. | Nothing is recorded. |
| `confirmed` | Progress: the flow may advance and the new state may be shown as "confirming". | The observation may be stored as pending, labelled `confirmed`. It is not a financial fact. |
| `finalized` | The outcome is final. | The only commitment at which a settlement, refund, cancellation or reputation change is recorded as authoritative. |

- The SDK exposes this as `commitmentFor('ui-progress')` → `confirmed` and
  `commitmentFor('settlement-record')` → `finalized`. Every SDK RPC helper takes
  the commitment as a required argument; there is no default.
- A transaction that was `confirmed` and then dropped by a fork leaves no
  authoritative record, because none was written before `finalized`.
- A failed transaction is reported as failed with its decoded program error. The
  UI never shows success for it.
