// docs/13-DECISIONS.md §10.1: every rule, on its own, decides the verdict.

import { toHex } from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import type { Commit, GithubOutcome, PullRequest, Repository } from './github.js';
import {
  checkPreconditions,
  commitTrailers,
  evaluateEvidence,
  requiredTrailers,
  type RuleResult,
  type Verdict,
} from './rules.js';
import { notFound, ok, unavailable } from './testing/fakes.js';
import {
  ACCEPTED_AT,
  DEVELOPER,
  DEVELOPER_GITHUB_ID,
  HEAD_SHA,
  headCommit,
  iso,
  mergedPullRequest,
  PR_NUMBER,
  REPO,
  submittedTask,
  TASK_ID,
  VERIFICATION_DEADLINE,
  WORK_DEADLINE,
} from './testing/fixtures.js';

const task = submittedTask();
const submission = {
  submissionNonce: 1n,
  evidenceHash: toHex(task.evidenceHash),
  prNumber: PR_NUMBER,
};

function evaluate(
  pullRequest: GithubOutcome<PullRequest>,
  options: {
    repository?: GithubOutcome<Repository> | null;
    developerGithubId?: bigint | null;
    headCommit?: GithubOutcome<Commit> | null;
  } = {},
): Verdict {
  return evaluateEvidence(
    {
      repo: REPO,
      task,
      submission,
      developerGithubId:
        options.developerGithubId === undefined
          ? BigInt(DEVELOPER_GITHUB_ID)
          : options.developerGithubId,
      pullRequest,
      repository: options.repository ?? null,
      taskId: TASK_ID,
      developerWallet: DEVELOPER.toBase58(),
      headCommit: options.headCommit === undefined ? ok(headCommit()) : options.headCommit,
    },
    [],
  );
}

function failed(verdict: Verdict): string[] {
  return verdict.rules.filter((rule) => rule.passed === false).map((rule) => rule.rule);
}

describe('evaluateEvidence', () => {
  it('is VERIFIED when R1–R9, R11 and R12 all hold', () => {
    const verdict = evaluate(ok(mergedPullRequest()));
    expect(verdict.status).toBe('VERIFIED');
    expect(verdict.rules.map((rule) => rule.rule)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R11',
      'R12',
    ]);
    expect(verdict.rules.every((rule) => rule.passed === true)).toBe(true);
    expect(verdict.recomputedHash).toBe(toHex(task.evidenceHash));
  });

  it.each<[string, Partial<PullRequest>, string[]]>([
    ['R2: targets another repository', { baseRepo: 'octo-org/other' }, ['R2']],
    ['R2: the repository was renamed', { baseRepo: 'new-org/parser' }, ['R2']],
    [
      'R3: the repository is newer than the task',
      { baseRepoCreatedAt: iso(task.createdAt) },
      ['R3'],
    ],
    ['R4: not merged', { merged: false, mergedAt: null, mergedBy: null }, ['R4']],
    ['R5: written by someone else', { author: { id: 9999, login: 'someone-else' } }, ['R5']],
    [
      'R6: merged by its own author',
      { mergedBy: { id: DEVELOPER_GITHUB_ID, login: 'dev-octocat' } },
      ['R6'],
    ],
    ['R6: GitHub does not say who merged it', { mergedBy: null }, ['R6']],
    ['R7: merged before acceptance', { mergedAt: iso(ACCEPTED_AT) }, ['R7']],
    ['R8: merged after the work deadline', { mergedAt: iso(WORK_DEADLINE + 1n) }, ['R8']],
    [
      'R9: a later commit (or force-push) changed the head',
      { headSha: HEAD_SHA.replace(/7$/, '8') },
      ['R9'],
    ],
  ])('is REJECTED for %s', (_, patch, expectedFailures) => {
    const verdict = evaluate(ok(mergedPullRequest(patch)));
    expect(verdict.status).toBe('REJECTED');
    expect(failed(verdict)).toEqual(expectedFailures);
  });

  it('accepts a merge exactly at the work deadline (R8 boundary)', () => {
    expect(evaluate(ok(mergedPullRequest({ mergedAt: iso(WORK_DEADLINE) }))).status).toBe(
      'VERIFIED',
    );
  });

  it('rejects R5 when the developer has no connected GitHub identity', () => {
    const verdict = evaluate(ok(mergedPullRequest()), { developerGithubId: null });
    expect(verdict.status).toBe('REJECTED');
    expect(failed(verdict)).toEqual(['R5']);
  });

  it('matches the identity by numeric id, not by login', () => {
    const renamed = mergedPullRequest({ author: { id: DEVELOPER_GITHUB_ID, login: 'renamed' } });
    expect(evaluate(ok(renamed)).status).toBe('VERIFIED');
    const impostor = mergedPullRequest({ author: { id: 5, login: 'dev-octocat' } });
    expect(failed(evaluate(ok(impostor)))).toEqual(['R5']);
  });

  it('never verifies a hash that was not made from this pull request', () => {
    const arbitrary = { ...submission, evidenceHash: 'ab'.repeat(32) };
    const verdict = evaluateEvidence(
      {
        repo: REPO,
        task: { ...task, evidenceHash: new Uint8Array(32).fill(0xab) },
        submission: arbitrary,
        developerGithubId: BigInt(DEVELOPER_GITHUB_ID),
        pullRequest: ok(mergedPullRequest()),
        repository: null,
        taskId: TASK_ID,
        developerWallet: DEVELOPER.toBase58(),
        headCommit: ok(headCommit()),
      },
      [],
    );
    expect(verdict.status).toBe('REJECTED');
    expect(failed(verdict)).toEqual(['R9']);
  });

  it('reports every failed rule, not just the first', () => {
    const verdict = evaluate(
      ok(mergedPullRequest({ baseRepo: 'x/y', author: { id: 5, login: 'other' } })),
    );
    expect(failed(verdict)).toEqual(['R2', 'R5']);
  });

  it('leaves merge-dependent rules unevaluated for an unmerged pull request', () => {
    const verdict = evaluate(ok(mergedPullRequest({ merged: false, mergedAt: null })));
    const unevaluated = verdict.rules.filter((rule) => rule.passed === null);
    expect(unevaluated.map((rule) => rule.rule)).toEqual(['R6', 'R7', 'R8']);
  });

  // M-01 of the security review: before R11 and R12 any pull request by the
  // developer, merged by someone else in the right repository inside the work
  // window, was VERIFIED, whatever it was about.
  describe('R11 and R12: the pull request must be made for this task and this wallet', () => {
    const commit = (message: string) => ok({ sha: HEAD_SHA, message });
    const wallet = DEVELOPER.toBase58();
    const OTHER_TASK = '99999999-9999-4999-8999-999999999999';
    const OTHER_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

    it('rejects an unrelated merged pull request that satisfies every other rule', () => {
      const verdict = evaluate(ok(mergedPullRequest()), {
        headCommit: commit('Fix a typo in the README'),
      });
      expect(verdict.status).toBe('REJECTED');
      expect(failed(verdict)).toEqual(['R11', 'R12']);
      // Everything the old rule set checked still passes: this is the gap that was closed.
      const before = verdict.rules.filter((rule) => /^R[1-9]$/.test(rule.rule));
      expect(before.every((rule) => rule.passed === true)).toBe(true);
    });

    it.each([
      ['made for a different task', requiredTrailers(OTHER_TASK, wallet), ['R11']],
      [
        'naming two tasks, this one among them',
        `${requiredTrailers(TASK_ID, wallet)}\nTaskra-Task: ${OTHER_TASK}`,
        ['R11'],
      ],
      ['paying a different wallet', requiredTrailers(TASK_ID, OTHER_WALLET), ['R12']],
      [
        'naming two wallets, the developer among them',
        `${requiredTrailers(TASK_ID, wallet)}\nTaskra-Developer: ${OTHER_WALLET}`,
        ['R12'],
      ],
      ['with the task named but no wallet', `Taskra-Task: ${TASK_ID}`, ['R12']],
      ['with the wallet named but no task', `Taskra-Developer: ${wallet}`, ['R11']],
      [
        'that only mentions the reference inside a sentence',
        `Work for Taskra-Task: ${TASK_ID} and Taskra-Developer: ${wallet} as discussed`,
        ['R11', 'R12'],
      ],
      [
        'whose wallet differs only in letter case',
        requiredTrailers(TASK_ID, wallet.toLowerCase()),
        ['R12'],
      ],
    ])('rejects a pull request %s', (_, message, expected) => {
      const verdict = evaluate(ok(mergedPullRequest()), {
        headCommit: commit(`Subject\n\n${message}`),
      });
      expect(verdict.status).toBe('REJECTED');
      expect(failed(verdict)).toEqual(expected);
    });

    it.each([
      [
        'Windows line endings',
        `Subject\r\n\r\n${requiredTrailers(TASK_ID, wallet).replace('\n', '\r\n')}\r\n`,
      ],
      [
        'an upper-case task id and key',
        `Subject\n\nTASKRA-TASK: ${TASK_ID.toUpperCase()}\nTaskra-Developer: ${wallet}`,
      ],
      [
        'trailing spaces and other trailers',
        `Subject\n\nSigned-off-by: A <a@example.com>\nTaskra-Task:   ${TASK_ID}  \nTaskra-Developer:\t${wallet}\n`,
      ],
      [
        'the same lines repeated',
        `${requiredTrailers(TASK_ID, wallet)}\n${requiredTrailers(TASK_ID, wallet)}`,
      ],
    ])('accepts %s', (_, message) => {
      expect(evaluate(ok(mergedPullRequest()), { headCommit: commit(message) }).status).toBe(
        'VERIFIED',
      );
    });

    it('rejects when GitHub does not have the head commit', () => {
      const verdict = evaluate(ok(mergedPullRequest()), { headCommit: notFound() });
      expect(verdict.status).toBe('REJECTED');
      expect(failed(verdict)).toEqual(['R11']);
    });

    it.each([
      ['GitHub cannot return the head commit', unavailable('GitHub answered 502')],
      ['the head commit was never read', null],
    ])('is PENDING, not a verdict, when %s', (_, outcome) => {
      const verdict = evaluate(ok(mergedPullRequest()), { headCommit: outcome });
      expect(verdict.status).toBe('PENDING');
    });

    it('reads trailers line by line', () => {
      expect(
        commitTrailers(`a\nTaskra-Task: X1\nTaskra-task: x1\nTaskra-Developer: Abc\n`),
      ).toEqual({
        tasks: ['x1'],
        developers: ['Abc'],
      });
      expect(commitTrailers('nothing here')).toEqual({ tasks: [], developers: [] });
    });
  });

  describe('R10: GitHub failures are PENDING, never a verdict', () => {
    it.each([
      ['an outage', unavailable('GitHub answered 503')],
      ['a rate limit or revoked access', unavailable('GitHub answered 403')],
      ['a timeout', unavailable('GitHub did not answer in time')],
    ])('for %s', (_, outcome) => {
      const verdict = evaluate(outcome);
      expect(verdict.status).toBe('PENDING');
      expect(verdict.rules.at(-1)).toMatchObject({ rule: 'R10', passed: null });
    });

    it('when the pull request is missing and the repository cannot be checked', () => {
      expect(evaluate(notFound(), { repository: unavailable('GitHub answered 502') }).status).toBe(
        'PENDING',
      );
    });

    it('when GitHub reports a merge without its merge commit', () => {
      expect(evaluate(ok(mergedPullRequest({ mergeCommitSha: null }))).status).toBe('PENDING');
    });
  });

  it('rejects R1 when the repository exists but the pull request does not', () => {
    const verdict = evaluate(notFound(), {
      repository: ok({ fullName: REPO, createdAt: '2020-01-01T00:00:00Z' }),
    });
    expect(verdict.status).toBe('REJECTED');
    expect(failed(verdict)).toEqual(['R1']);
  });

  it('rejects R3 when the repository was deleted or made private', () => {
    const verdict = evaluate(notFound(), { repository: notFound() });
    expect(verdict.status).toBe('REJECTED');
    expect(failed(verdict)).toEqual(['R3']);
  });
});

describe('checkPreconditions', () => {
  const base = {
    task,
    chainTime: ACCEPTED_AT + 2_000n,
    taskIdMatches: true,
    termsMatch: true,
    submission,
  };
  const reasons = (rules: readonly RuleResult[]) =>
    rules.filter((rule) => rule.passed !== true).map((rule) => rule.rule);

  it('proceeds for the current, finalized submission inside the verification window', () => {
    const result = checkPreconditions(base);
    expect(result.kind).toBe('proceed');
    expect(result.rules.map((rule) => rule.rule)).toEqual(['P1', 'P2', 'P3']);
  });

  it('rejects metadata that does not hash to the on-chain terms', () => {
    const result = checkPreconditions({ ...base, termsMatch: false });
    expect(result.kind).toBe('rejected');
    expect(reasons(result.rules)).toEqual(['P1']);
  });

  it('rejects an account that is not the task the record names, whatever its terms', () => {
    const result = checkPreconditions({ ...base, taskIdMatches: false });
    expect(result.kind).toBe('rejected');
    expect(result.rules).toEqual([expect.objectContaining({ rule: 'P1', passed: false })]);
  });

  it('waits while the submission is not finalized yet', () => {
    const result = checkPreconditions({ ...base, task: { ...task, submissionNonce: 0n } });
    expect(result.kind).toBe('pending');
  });

  it('rejects a stale submission after a resubmission', () => {
    const newer = { ...task, submissionNonce: 2n };
    expect(checkPreconditions({ ...base, task: newer }).kind).toBe('rejected');
    const sameNonceOtherHash = { ...task, evidenceHash: new Uint8Array(32).fill(1) };
    expect(checkPreconditions({ ...base, task: sameNonceOtherHash }).kind).toBe('rejected');
  });

  it.each(['UNDER_REVIEW', 'DISPUTED', 'SETTLED', 'REFUNDED'] as const)(
    'rejects when the task is %s',
    (state) => {
      const result = checkPreconditions({ ...base, task: { ...task, state } });
      expect(result.kind).toBe('rejected');
      expect(reasons(result.rules)).toEqual(['P2']);
    },
  );

  it('respects the verification deadline boundary', () => {
    expect(checkPreconditions({ ...base, chainTime: VERIFICATION_DEADLINE }).kind).toBe('proceed');
    const late = checkPreconditions({ ...base, chainTime: VERIFICATION_DEADLINE + 1n });
    expect(late.kind).toBe('rejected');
    expect(reasons(late.rules)).toEqual(['P3']);
  });
});
