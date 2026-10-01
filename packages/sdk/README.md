# @taskra/sdk

A pure TypeScript library for the Taskra program: addresses, unsigned
instructions, account decoding, hashes, fee and timeline arithmetic, and error
decoding. It is used by the web app and the API.

The Solana program is the final authority. Everything here either prepares data
for the program or describes what the program has recorded.

## What the SDK never does

- It never holds a private key or seed phrase and never signs anything. It
  returns unsigned transactions; a wallet approves them.
- It imports no keypair or signing API. `src/no-signing.test.ts` fails the build
  if a shipped source file does.
- It contains no GitHub credentials or server secrets and reads no environment
  variables or files.
- It does not decide whether a user is authorized and does not declare a task
  settled. Helpers such as `hasValidAttestation` report facts; the program
  re-checks every condition itself.
- It has no default USDC mint. `createTaskraConfig` requires the mint.

## Configuration

```ts
import { createTaskraConfig } from '@taskra/sdk';

const config = createTaskraConfig({
  cluster: 'devnet',
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT!, // supplied by configuration, never hardcoded
});
// config.programId defaults to the address in the IDL.
```

## Modules

| Module | Purpose |
|---|---|
| `config` | Cluster, program id, USDC mint. |
| `pda` | `findPlatformAddress`, `findTaskAddress`, `findEscrowAddress`, `findProgramDataAddress`, `findAssociatedTokenAddress`, UUID ↔ task-id bytes. |
| `accounts` | `PlatformAccount`, `TaskAccount`, `decodePlatform`, `decodeTask`. Every `u64`/`i64` is a `bigint`. |
| `instructions` | One unsigned builder per program instruction (14), plus `createUsdcAccountIdempotent`. |
| `transaction` | `buildUnsignedTransaction`, `requiredApprovals`. |
| `enums` | `TaskState`, `Outcome`, `DisputeResolution` in their canonical names. |
| `fees` | `computeFee`, `splitSettlement` (bigint only). |
| `hashes` | `evidenceHash`, `termsHash`, `normalizeAcceptanceCriteria`. |
| `attestation` | `currentSubmission`, `nextSubmissionNonce`, `hasValidAttestation`, `matchesCurrentSubmission`. |
| `timeline` | `computeTimeline`, `maxClientLockSeconds`, `submissionWindows`. |
| `errors` | `decodeProgramError`, `TASKRA_ERROR_CODES`. |
| `commitment`, `rpc` | The confirmation policy and read helpers that require an explicit commitment. |

## Money

All amounts are `bigint` token base units (USDC has 6 decimals). No function in
this package accepts a `number` for an amount, and none uses floating point.
`computeFee(amount, feeBps)` is `floor(amount * feeBps / 10000)`, the same as the
program, and is tested against the same vectors as the Rust unit tests. It is
informational: the fee actually charged is the one the program computes.

## Hashes: this implementation is canonical

The evidence and terms hashes are defined in `docs/13-DECISIONS.md` §5.2, §5.3
and §10.3:

```text
hash  = SHA-256( PREFIX || LP(field_1) || ... || LP(field_n) )
LP(x) = byte length of x as a 4-byte big-endian integer, followed by x
```

- `evidenceHash({ repo, prNumber, headSha })` uses `taskra:evidence:v1`.
- `termsHash({ repo, acceptanceCriteria, workDuration, amount })` uses
  `taskra:terms:v1`.

**The TypeScript helpers in `src/hashes.ts` are the canonical implementation.**
In particular, acceptance criteria are normalized with
`text.normalize('NFC')` and then `String.prototype.trim()`, in that order, and
those two JavaScript functions are the definition. Any other implementation must
reproduce their output exactly. The published vectors (E1–E3, T1–T2) are asserted
in `src/hashes.test.ts` and, independently, in
`programs/taskra/tests/evidence.rs`.

`repo` is ASCII lower-cased and `headSha` is lower-cased before hashing.
Malformed inputs (URLs, `.git` suffixes, wrong-length SHAs, non-bigint numbers)
throw `TaskraSdkError`.

## Commitment

```ts
commitmentFor('ui-progress'); // 'confirmed'
commitmentFor('settlement-record'); // 'finalized'
```

Use `confirmed` to advance a UI. Use `finalized` before a settlement, refund or
reputation change is treated as authoritative. `fetchPlatform`, `fetchTask`,
`fetchTokenAmount` and `fetchChainTime` take the commitment as a required
argument; there is no default.

## The IDL

`src/generated/idl.ts` is generated from `target/idl/taskra.json`. Account
layouts, instruction account lists, discriminators, seeds, error messages and the
program address are read from it. After any program change:

```bash
pnpm anchor:build
pnpm sdk:idl
```

`src/idl.test.ts` fails if the generated module differs from the current build.

## Tests

```bash
pnpm --filter @taskra/sdk test   # unit tests
pnpm sdk:validator-loop          # end-to-end against solana-test-validator
```

`pnpm sdk:validator-loop` starts a throwaway validator, creates a real SPL mint,
initializes the platform with a short-window test profile (review 10 s, grace
5 s, dispute timeout 8 s) and drives create → approve, review expiry, cancel and
both dispute-fallback branches through the SDK, printing every signature, the
commitment used and the balances before and after.

`e2e/` contains that script and the platform initialization CLI. Those files load
test keypairs and sign; they are tooling around the SDK and are not part of the
published package (`src/`).
