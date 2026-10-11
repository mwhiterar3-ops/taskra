# Contributing to Taskra

Taskra is an escrow for small technical jobs on Solana. Parts of it hold other
people's money and parts of it do not. This guide exists so that several people
can work on the parts that do not, at the same time, without stepping on each
other or on the parts that do.

**Status:** runs on a local validator only. Not deployed, not independently
audited, not for real funds. See the README and `docs/15-SECURITY-AUDIT.md`.

## Checklist for a first contribution

1. Get access: ask the maintainer to add you as a collaborator, or fork the
   repository.
2. Install Node 24.18.1 and pnpm 12.3.4, then `pnpm install --frozen-lockfile`.
3. Pick an open issue labelled `frontend`, and comment on it to claim it.
4. Branch from `publish/colosseum` (`feat/frontend-...`, `fix/frontend-...`,
   `test/frontend-...`).
5. Make the change the issue describes, with a test where behaviour changes.
6. Run the five commands under [Checks](#checks).
7. Open a pull request into `publish/colosseum` with `Closes #<issue>`, the
   result of each command, and screenshots for anything visible.
8. Ask someone other than yourself to review it. Do not merge your own.

The rest of this document explains each step.

## What you can work on

Open work is in the [issues](https://github.com/mwhiterar3-ops/taskra/issues).
Issues labelled `frontend` are in `apps/web` and are written to be done
independently. `good first issue` marks the smallest ones.

### Restricted areas

Changes here move funds, decide who is paid, or guard those decisions. They
need the maintainer's agreement in an issue **before** any code is written, and
they are never part of a frontend pull request:

| Area | Why |
| --- | --- |
| `programs/` | The escrow program |
| `apps/api/`, `apps/attester/` | Authentication, settlement records, verification, the only signing key |
| `apps/api/migrations/` | Database constraints the security model relies on |
| `packages/sdk/`, `packages/shared/` | Hashes, instruction builders and account decoding shared by everything |
| `scripts/`, `Anchor.toml`, `Cargo.*`, dependency versions | Build, deploy and supply chain |

Inside `apps/web`, these files build and send transactions or handle sign-in.
A frontend issue may change text and markup around them, not their logic,
unless the issue says so explicitly:

- `src/components/TaskActions.tsx`: the `send`, `run`, `resolve`, `fund`,
  `submitEvidence` and `submitRejection` functions
- `src/lib/transaction.ts`, `src/lib/wallet.ts`, `src/lib/actions.ts`
- `src/hooks/use-transaction.ts`, `src/state/app-context.tsx`

Two rules the UI must never break (`docs/08-UI-UX-SPEC.md`): success is shown
only for a **finalized** transaction, and what the page says about a task's
state comes from the chain, not from the API or from what the user just did.

## Workflow

1. **Pick an issue** and comment that you are taking it. One person per issue.
   If you stop, say so.
2. **Branch** from the default branch, `publish/colosseum`:

   ```bash
   git fetch origin
   git switch -c feat/frontend-task-list-paging origin/publish/colosseum
   ```

   Names: `feat/frontend-<short-description>`, `fix/frontend-<short-description>`,
   `test/frontend-<short-description>`, `docs/<short-description>`.

   Collaborators push branches to this repository. Everyone else forks it and
   opens the pull request from the fork.

3. **Do what the issue says and nothing else.** If you find something else
   worth fixing, open an issue for it. A pull request that mixes two concerns
   will be asked to split.
4. **Run the checks** (below) and write down what you ran.
5. **Open a pull request** against `publish/colosseum` with `Closes #<issue>`
   in the description, filled in from the template.
6. **Ask for review.** Do not merge your own pull request. Answer review
   comments with a commit or a reply; resolve a thread only when the reviewer's
   point is addressed.

### Keeping your branch current

```bash
git fetch origin
git rebase origin/publish/colosseum      # or: git merge origin/publish/colosseum
```

Rebase only your own branch, and only before review starts; after that, add
commits so the reviewer can see what changed. Never force-push to
`publish/colosseum`.

## Setup

Requirements: **Node 24.18.1** and **pnpm 12.3.4**. Both are pinned exactly:
Node in `.nvmrc` and the `engines` field of `package.json`, pnpm in its
`packageManager` field. Another Node version may be refused or behave
differently. The project is developed on Ubuntu under WSL; Linux and macOS
should work, and native Windows has not been tried.

```bash
pnpm install --frozen-lockfile
```

Most frontend issues need nothing else: the tests use fakes for the wallet, the
API and the chain.

To click through the app you need the whole local stack (a Solana test
validator, PostgreSQL, the API and the attestation service). That needs Linux
or WSL, the Solana and Anchor toolchains and Docker; follow "Local development"
in the README and `docs/16-DEMO-RUNBOOK.md`. If you cannot run it, say so in
your pull request and describe what you verified instead. Do not claim a manual
check you did not do.

## Checks

Run these before you open a pull request and paste the result lines into it:

```bash
pnpm format:check                       # Prettier; `pnpm format` fixes
pnpm lint                               # ESLint over the repository
pnpm --filter @taskra/web typecheck
pnpm --filter @taskra/web test
pnpm --filter @taskra/web build
```

`pnpm format:check` does not look at Markdown: `.prettierignore` excludes
`*.md`, so documentation is formatted by hand.

A `quality` check runs the same five commands on every pull request, once the
workflow in `.github/workflows/ci.yml` is on the default branch. It does **not**
run the API, attestation-service, program or end-to-end suites, so a green
check is not evidence about those. If you touched anything outside `apps/web`,
run `pnpm test` as well; it starts its own throwaway PostgreSQL and needs no
setup.

Rules for tests:

- A change in behaviour comes with a test that fails without it.
- Do not delete, skip or loosen a test to get a green run. If a test is wrong,
  say why in the pull request.
- Query by role or visible text in component tests, as a user would.

## Pull requests

- One issue per pull request. Small is good.
- Describe what changed and how you checked it. For anything visible, attach
  before and after screenshots, including a narrow (about 375 px) viewport.
- For interactive changes, say how it behaves with the keyboard alone.
- Do not add or upgrade dependencies in a frontend pull request. If you think
  one is needed, raise it in the issue first: the workspace has a
  minimum-release-age policy and exact version pins.
- Match the surrounding code: TypeScript strict, no `any`, plain CSS in
  `apps/web/src/app/globals.css`, no new styling system.

## Secrets and private data

- Never commit `.env`, keypair files (`*-keypair.json`), `.localnet/` or
  anything from `target/deploy/`. They are git-ignored; keep it that way.
- Never paste environment values, connection strings, keys or session cookies
  into an issue, a pull request, a screenshot or a log excerpt.
- Only `NEXT_PUBLIC_*` variables may be read by `apps/web`. They are public by
  definition: never put a secret in one.
- Your commits carry your e-mail address and this repository is public. If you
  want to keep it private, use your GitHub `noreply` address
  (`git config user.email "<id>+<login>@users.noreply.github.com"`).

## Reporting a security problem

Do not open a public issue for something that could let funds be moved, locked
or mis-recorded. Contact the maintainer privately first. Known open findings
are listed in `docs/15-SECURITY-AUDIT.md` §7; those can be discussed in the
open.
