// The verification rules of docs/13-DECISIONS.md §10, as a pure function of
// three inputs: the Task account (read at finalized), the database's record of
// the submission, and what GitHub returned. No rule reads a value supplied by a
// request: the repository comes from metadata bound by the on-chain terms hash,
// the head SHA comes from GitHub, and the hash is recomputed here.

import { evidenceHash, type TaskAccount, toHex } from '@taskra/sdk';
import type { GithubOutcome, PullRequest, Repository } from './github.js';

export const RULESET_VERSION = 'taskra-rules-v1';

export type VerificationStatus = 'VERIFIED' | 'REJECTED' | 'PENDING';

export interface RuleResult {
  readonly rule: string;
  /** `null`: not evaluated, because an earlier fact made it impossible to. */
  readonly passed: boolean | null;
  readonly reason: string;
}

export interface Verdict {
  readonly status: VerificationStatus;
  readonly rules: readonly RuleResult[];
  /** The evidence hash recomputed from GitHub's data, when a pull request was found. */
  readonly recomputedHash: string | null;
}

export interface SubmissionRecord {
  readonly submissionNonce: bigint;
  /** Lower-case hex, as registered from the Task account. */
  readonly evidenceHash: string;
  readonly prNumber: bigint;
}

const pass = (rule: string, reason: string): RuleResult => ({ rule, passed: true, reason });
const fail = (rule: string, reason: string): RuleResult => ({ rule, passed: false, reason });
const skip = (rule: string, reason: string): RuleResult => ({ rule, passed: null, reason });

function unixSeconds(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

export type Preconditions =
  | { readonly kind: 'proceed'; readonly rules: readonly RuleResult[] }
  /** Final for this submission: it can no longer be attested. */
  | { readonly kind: 'rejected'; readonly rules: readonly RuleResult[] }
  /** Not decidable yet (for example the submission is not finalized). Retry. */
  | { readonly kind: 'pending'; readonly rules: readonly RuleResult[] };

/**
 * Checks that depend only on the chain and the database, evaluated before
 * GitHub is contacted. They mirror what `record_attestation` itself requires,
 * so a VERIFIED result is only ever produced for a submission the program
 * would accept an attestation for.
 */
export function checkPreconditions(input: {
  readonly task: TaskAccount;
  readonly chainTime: bigint;
  readonly termsMatch: boolean;
  readonly submission: SubmissionRecord;
}): Preconditions {
  const { task, submission } = input;
  const rules: RuleResult[] = [];

  if (!input.termsMatch) {
    rules.push(
      fail('P1', 'The stored task terms do not hash to the terms hash on the Task account.'),
    );
    return { kind: 'rejected', rules };
  }
  rules.push(pass('P1', 'Stored task terms match the on-chain terms hash.'));

  if (task.submissionNonce < submission.submissionNonce) {
    rules.push(skip('P2', 'This submission is not finalized on-chain yet.'));
    return { kind: 'pending', rules };
  }
  if (
    task.submissionNonce !== submission.submissionNonce ||
    toHex(task.evidenceHash) !== submission.evidenceHash
  ) {
    rules.push(fail('P2', 'This submission was superseded by a newer one.'));
    return { kind: 'rejected', rules };
  }
  if (task.state !== 'SUBMITTED') {
    rules.push(fail('P2', `The task is ${task.state}; it is no longer awaiting verification.`));
    return { kind: 'rejected', rules };
  }
  rules.push(pass('P2', 'This is the current submission and the task is SUBMITTED.'));

  if (input.chainTime > task.verificationDeadline) {
    rules.push(fail('P3', 'The verification deadline has passed.'));
    return { kind: 'rejected', rules };
  }
  rules.push(pass('P3', 'The verification deadline has not passed.'));
  return { kind: 'proceed', rules };
}

export interface EvidenceInput {
  /** Canonical `owner/name` from the task's verified metadata. */
  readonly repo: string;
  readonly task: TaskAccount;
  readonly submission: SubmissionRecord;
  /** Numeric GitHub id linked to the developer's wallet, if any. */
  readonly developerGithubId: bigint | null;
  readonly pullRequest: GithubOutcome<PullRequest>;
  /** Fetched only when the pull request was not found, to tell R1/R4 from R3. */
  readonly repository: GithubOutcome<Repository> | null;
}

/** R1–R10. Call only after `checkPreconditions` returned `proceed`. */
export function evaluateEvidence(
  input: EvidenceInput,
  preconditions: readonly RuleResult[],
): Verdict {
  const { task, submission, pullRequest } = input;
  const rules: RuleResult[] = [...preconditions];
  const pending = (reason: string): Verdict => ({
    status: 'PENDING',
    rules: [...rules, skip('R10', reason)],
    recomputedHash: null,
  });

  if (pullRequest.kind === 'unavailable') return pending(pullRequest.reason);

  if (pullRequest.kind === 'not_found') {
    const repository = input.repository;
    if (repository === null || repository.kind === 'unavailable') {
      return pending(repository === null ? 'The repository was not checked.' : repository.reason);
    }
    if (repository.kind === 'not_found') {
      rules.push(fail('R3', `Repository ${input.repo} does not exist or is not public.`));
    } else {
      rules.push(
        fail('R1', `${input.repo} has no pull request #${submission.prNumber.toString()}.`),
      );
    }
    return { status: 'REJECTED', rules, recomputedHash: null };
  }

  const pr = pullRequest.value;
  rules.push(pass('R1', `Pull request #${pr.number.toString()} exists on GitHub.`));

  const targetsRepo = pr.baseRepo.toLowerCase() === input.repo;
  rules.push(
    targetsRepo
      ? pass('R2', `The pull request targets ${input.repo}.`)
      : fail('R2', `The pull request targets ${pr.baseRepo}, not ${input.repo}.`),
  );

  const repoCreated = unixSeconds(pr.baseRepoCreatedAt);
  rules.push(
    repoCreated < task.createdAt
      ? pass('R3', 'The repository existed before the task was created.')
      : fail('R3', 'The repository was created at or after the task.'),
  );

  const mergedAt = pr.merged && pr.mergedAt !== null ? unixSeconds(pr.mergedAt) : null;
  rules.push(
    mergedAt !== null
      ? pass('R4', 'The pull request is merged.')
      : fail('R4', 'The pull request is not merged.'),
  );

  if (input.developerGithubId === null) {
    rules.push(fail('R5', 'The developer wallet has no connected GitHub identity.'));
  } else if (pr.author === null || BigInt(pr.author.id) !== input.developerGithubId) {
    rules.push(fail('R5', "The pull request author is not the developer's GitHub identity."));
  } else {
    rules.push(pass('R5', `The pull request author is ${pr.author.login}.`));
  }

  if (mergedAt === null) {
    rules.push(skip('R6', 'Not merged.'), skip('R7', 'Not merged.'), skip('R8', 'Not merged.'));
  } else {
    if (pr.mergedBy === null || pr.author === null) {
      rules.push(fail('R6', 'GitHub does not report who merged the pull request.'));
    } else if (pr.mergedBy.id === pr.author.id) {
      rules.push(fail('R6', 'The pull request was merged by its own author.'));
    } else {
      rules.push(pass('R6', `Merged by ${pr.mergedBy.login}, who is not the author.`));
    }
    rules.push(
      mergedAt > task.acceptedAt
        ? pass('R7', 'Merged after the task was accepted.')
        : fail('R7', 'Merged before the task was accepted.'),
      mergedAt <= task.workDeadline
        ? pass('R8', 'Merged at or before the work deadline.')
        : fail('R8', 'Merged after the work deadline.'),
    );
  }

  // R9: recomputed from the task's repository, the claimed number and GitHub's
  // own head SHA. A hash of anything else can never match.
  const recomputed = toHex(
    evidenceHash({ repo: input.repo, prNumber: submission.prNumber, headSha: pr.headSha }),
  );
  rules.push(
    recomputed === toHex(task.evidenceHash)
      ? pass('R9', 'The evidence hash recomputed from GitHub equals the on-chain hash.')
      : fail(
          'R9',
          'The evidence hash recomputed from GitHub differs from the on-chain hash (the pull request head changed, or the hash was not made from this pull request).',
        ),
  );

  const verified = rules.every((rule) => rule.passed === true);
  if (verified && pr.mergeCommitSha === null) {
    // The audit record of a VERIFIED result must name the merge commit.
    return pending('GitHub has not reported the merge commit yet.');
  }
  return { status: verified ? 'VERIFIED' : 'REJECTED', rules, recomputedHash: recomputed };
}
