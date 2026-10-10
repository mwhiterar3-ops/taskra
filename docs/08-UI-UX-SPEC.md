# Taskra — UI/UX Specification

Build a focused professional Web3 application.

## Primary routes

/
 /tasks
 /tasks/new
 /tasks/:id
 /dashboard/client
 /dashboard/developer
 /profile/:wallet

## Client flow

Connect wallet
→ Create task
→ Fund escrow
→ Monitor task
→ Review evidence
→ Approve/reject
→ View settlement

## Developer flow

Connect wallet
→ Browse tasks
→ View task
→ Accept
→ Submit evidence
→ Monitor review
→ Receive payment
→ View reputation

## Required transaction states

- wallet disconnected
- connecting
- awaiting signature
- signing
- submitted
- confirming
- confirmed
- failed

Show transaction signatures/explorer links where appropriate.

Never display success when the underlying blockchain action failed.

Keep the UI centered around the core economic loop. Do not build social/productivity features outside the MVP.

## Implementation (`apps/web`)

### Where the page's facts come from

| Shown | Source |
|---|---|
| Task state, parties, amount, fee split, deadlines, attestation | The Task and Platform accounts, read **by the browser** through the SDK at `confirmed`, with the cluster clock. Not the API. |
| Title, description, repository, criteria | The API. The browser recomputes the terms hash and shows a warning when it does not match the chain. |
| Verification rules, attestation status, transaction history | The API. |
| "Settled / refunded" with amounts | The API's settlement record, which exists only after finality. Until then a terminal state is shown as not final. |
| Task lists | The API's cache, labelled as its last observation. |

### Wallet and session states

`disconnected → connecting → connected → signing in → signed in`. "Connected"
means a wallet shared an address; only "signed in" means the API verified a
signature. A session belonging to a different wallet than the connected one
counts as signed out. After a reload the last wallet is reconnected and the
session cookie is re-checked.

Wallets are discovered through the Wallet Standard and must support
`standard:connect`, `solana:signMessage` and `solana:signTransaction`. The app
sends transactions itself, through its own RPC endpoint, so the wallet's
network setting does not decide where a transaction goes.

### Transaction states

| State | Meaning | Shown as |
|---|---|---|
| building | Fetching a blockhash and assembling the transaction with the SDK | pending |
| awaiting signature | The wallet is asking the user | pending |
| submitted | Broadcast; not yet confirmed | pending |
| confirmed | Confirmed; reported to the API; not final | pending, with "not final yet" |
| finalized | Final | **success** — the only success state |
| failed | Declined, refused by a program, expired, insufficient funds, or the RPC endpoint was lost | error, with the reason |

("signing" and "confirming" in the list above are the waits inside
*awaiting signature* and *submitted*.) While a transaction is in flight every
action button is disabled, and a second click is ignored. After every
transaction, successful or not, the page re-reads Solana.

If the RPC endpoint is lost after the transaction was sent, the app reports a
failure to *confirm*, not a failed transaction, and tells the user to check the
task: it never guesses an outcome.

### Actions

Buttons are offered from on-chain state, the cluster clock and the connected
wallet, following `13-DECISIONS.md` §2.6 (`src/lib/actions.ts`). A disabled
button says why. The program remains the authority: a button being shown
authorizes nothing.

| Route | Purpose |
|---|---|
| `/` | What Taskra is |
| `/tasks` | Browse by state |
| `/tasks/new` | Step 1: save a draft (no funds move) |
| `/tasks/:id` | Step 2: fund; then every action, verification, deadlines, history, settlement |
| `/dashboard/client`, `/dashboard/developer` | Tasks by role for the connected wallet |
| `/profile/:wallet` | Reputation (off-chain aggregate), verified work, GitHub identity link |

Dispute resolution by the platform authority appears on the task page when the
connected wallet is `platform.authority`.

### Evidence

Before submitting, the developer is shown the two lines the final commit of the
pull request must end with (`Taskra-Task: …`, `Taskra-Developer: …`), with the
task id and their own wallet filled in. Without them the pull request cannot be
verified, however it is merged.

### Not built

Search beyond a state filter, notifications, editing a draft (create a new
one), CI status, and any reliability reward.
