# Taskra — GitHub Verification Specification

GitHub is the primary evidence path for the MVP. A GitHub pull request is the only
MVP evidence type.

A pasted GitHub URL is NOT automatically verified.

## Evidence object

At minimum capture:
- evidence type
- repository URL
- PR URL / number when applicable
- PR head commit SHA
- submitter wallet
- connected GitHub identity
- submitted timestamp

## Evidence hash

`evidence_hash = SHA-256("taskra:evidence:v1" || LP(repo) || LP(pr_number) || LP(head_sha))`

where `LP(x)` is the byte length of `x` as a 4-byte big-endian integer followed by
`x`. The exact field formats and published test vectors are in `13-DECISIONS.md`
§5.2 and §10.3. `head_sha` replaces `merge_commit_sha`: every pull request has a
head SHA, merged or not.

The developer records this hash on-chain with `submit_work`. The program accepts
any non-zero 32 bytes; the hash authorizes nothing by itself. Money moves only
through an attestation bound to the task, the hash and the submission nonce, or
through the client's approval or the authority's decision.

## MVP verification

The authoritative rule table is `13-DECISIONS.md` §10. The verifier fetches the
pull request from GitHub and attests only if all of the following hold:

1. URL is a valid GitHub pull request.
2. The PR targets exactly the repository specified by the task at creation.
3. Repository exists and its `created_at` is earlier than the Taskra task creation timestamp. This is the definition of "pre-existing history".
4. Pull request exists and is merged.
5. PR author matches the connected GitHub identity.
6. `merged_by` differs from the PR author. A self-merge is REJECTED.
7. Merge timestamp is after task acceptance.
8. Merge timestamp is at or before the work deadline.
9. The evidence hash recomputed from GitHub's own data — the task's repository, the PR number and the merged PR's final head SHA — equals the hash recorded on the Task account. The verifier never trusts a hash or head SHA supplied in a request.
10. Verification result is persisted with an auditable reason per rule.

CI/test status is informational only. It is NOT a verification condition.

Use explicit VERIFIED / REJECTED / PENDING states.

## Lifecycle

- **Merged PR.** The head SHA is final. If the submitted hash matches, the
  attester records the attestation on-chain and the review window starts.
- **Unmerged PR.** Rule 4 fails: no attestation is recorded and the task stays
  `SUBMITTED`. The developer-dispute path applies (`13-DECISIONS.md` §2.4).
- **Later commits.** A new commit changes the head SHA, so the old hash no longer
  matches. The developer must resubmit, which starts a new submission nonce and
  voids any earlier attestation.
- **Arbitrary hash.** A hash of anything else can never match and is never
  attested. It can only delay the client's refund, never produce a payment
  (`13-DECISIONS.md` §2.7).

## Claims

Do not claim that a merged PR proves objective correctness. Taskra verifies evidence against predefined conditions.

## Failures

GitHub API failures must become PENDING and remain retryable. They must never
become VERIFIED.

## Implementation (`apps/attester`)

Verification and attestation live in one separate process, the **attestation
service**. It is the only code that talks to GitHub about evidence and the only
code that can load the attester key.

### GitHub access

- Identity (rule 5): the developer links a GitHub account to their wallet
  through GitHub's OAuth web flow in the API (`05-API-SPEC.md` §5). No scope is
  requested; the token is used once to read the account's numeric id and login
  and is then discarded. The numeric id is the identity; logins can change.
- Evidence: the service reads `GET /repos/{repo}/pulls/{number}` (and
  `GET /repos/{repo}` when the pull request is not found) from the public REST
  API. If `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are set it authenticates
  with them, which only raises the rate limit. Private repositories are not
  supported: they answer 404 and fail rule 3.
- **No webhooks** (`13-DECISIONS.md` §13). Verification runs when the developer
  registers evidence, and again whenever they ask.
- Everything GitHub returns is untrusted. Each response is validated field by
  field; only the validated fields are compared, hashed and stored. **Nothing
  fetched from a repository is ever executed**: there is no build, test run or
  checkout. CI status is not read at all.

### One run

1. Load the submission and the task metadata from the database.
2. Read the Task account at **`finalized`**. A submission that is only
   confirmed is `PENDING`.
3. Preconditions, before GitHub is contacted:
   - **P1** the stored repository, acceptance criteria, duration and amount hash
     to the on-chain `terms_hash` (so the repository cannot be swapped in the
     database);
   - **P2** this is the task's current submission (same nonce and hash) and the
     task is `SUBMITTED`;
   - **P3** the on-chain clock has not passed `verification_deadline`.
4. Fetch the pull request and evaluate R1–R9 (`13-DECISIONS.md` §10.1). The
   evidence hash is recomputed from the task's repository, the pull-request
   number and GitHub's own head SHA.
5. Append one `verification_results` row: status, every rule with its reason,
   `head_sha`, `merge_commit_sha`, author, `merged_by`, merge time, repository
   creation time, both hashes, the rule-set and verifier versions, the attester
   public key and the GitHub request ids.
6. Only if the status is `VERIFIED`: insert the `attestations` row in the same
   database transaction, then send one `record_attestation`.

### Outcomes

| Situation | Result |
|---|---|
| All of R1–R9 hold | `VERIFIED` → one attestation |
| Unmerged, self-merged, wrong author, wrong repository, merged outside the window | `REJECTED`, with the failed rules |
| New commit or force-push after the hash was submitted | `REJECTED` on R9; the developer resubmits the new hash on-chain |
| Developer resubmitted (new nonce) | The older submission is `REJECTED` on P2; it can never be attested |
| Repository deleted or made private | `REJECTED` on R3 |
| GitHub outage, timeout, rate limit, revoked or missing access, malformed response | `PENDING`; retried with backoff (5 s doubling to 5 min, at most 40 times) |
| Solana RPC failure | No result is written; the job is retried |
| Verification deadline passed | `REJECTED` on P3 |

A `REJECTED` or exhausted `PENDING` submission can be verified again: the
developer re-registers the evidence (for example after the pull request is
merged). Results are append-only, so every run stays in the audit trail.

## Attestation service security

| Question | Answer |
|---|---|
| Which process can request an attestation? | None directly. The API can only insert a **verification job** (`taskra_api` may write `verification_jobs`; it has no privilege on `verification_results` or `attestations`). A job is a request to *look*, not to sign. |
| Which process holds signing authority? | Only `apps/attester`. `ATTESTER_SECRET_KEY` is read by that process alone; the API's configuration cannot load it, and a test fails if any API source mentions a key or signing API. |
| What can the key sign? | `apps/attester/src/signer.ts` is the only file that touches the key. Its single operation builds, itself, a transaction with exactly one `record_attestation` instruction and signs that. There is no "sign this message" or "sign this transaction" entry point. |
| How is a request authenticated and authorized? | It is not trusted at all. The service has **no network listener**. For every job it re-derives the facts from the finalized Task account and from GitHub; the job contributes only "task T, submission nonce N, pull request #P", and P is checked by rule 9. |
| How are duplicates prevented? | One job per submission, claimed with `FOR UPDATE SKIP LOCKED`; at most one `VERIFIED` result per submission (partial unique index); one `attestations` row per submission (primary key), insertable only with a `VERIFIED` result for the same hash and nonce (trigger). On-chain, `record_attestation` requires `SUBMITTED` and the current hash and nonce, so a second one fails. |
| Stale or replayed results? | A result is bound to `(task, nonce, hash)`. After a resubmission the nonce differs: P2 rejects the job, and the program rejects the transaction. |
| Signing or delivery failures? | The signature is stored **before** the transaction is broadcast. Until the attestation is visible on the finalized Task account the row stays `SENT`; an unknown transaction is re-signed with a fresh blockhash after 90 s, at most 5 times; an RPC refusal is kept and retried. The row becomes `FAILED` (with a reason) when the submission is no longer current, the deadline has passed, or the program refused the key. A `FAILED` attestation moves no funds; the developer-dispute path still applies. |
| Wrong key configured? | The service refuses to start unless its key equals `platform.attester`. |
| Compromised attester key? | `13-DECISIONS.md` §7.5: the attacker can start review windows, nothing else. Response: the platform authority runs `rotate_keys` with a new attester (the old key stops working immediately), the new key is placed in the service's secret store, and the service is restarted. Attestations already recorded stay valid and should be reviewed against `verification_results`. |
| Compromised API or database, key intact? | A forged job cannot produce an attestation the facts do not support. A database writer could link a different GitHub account to a developer's wallet (rule 5 trusts that link), which is why the attestation service should connect with its own database login and why the database is not exposed to the API host's other tenants. |

Remaining trust: the attestation service trusts the `github_accounts` link in
the database and trusts GitHub's API responses. It does not trust the API
process, request bodies, or any hash or SHA supplied by a user.
