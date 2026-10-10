import { PublicKey } from '@solana/web3.js';
import { evidenceHash, type TaskAccount, termsHash } from '@taskra/sdk';
import type { Commit, PullRequest } from '../github.js';
import { requiredTrailers } from '../rules.js';

export const REPO = 'octo-org/parser';
export const CRITERIA = 'Parses transaction signatures\nReturns structured output';
export const WORK_DURATION = 172_800n;
export const AMOUNT = 100_000_000n;
export const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
export const MERGE_SHA = '89abcdef0123456789abcdef0123456789abcdef';
export const PR_NUMBER = 42n;
export const DEVELOPER_GITHUB_ID = 1001;
export const MAINTAINER_GITHUB_ID = 2002;

export const CREATED_AT = 1_760_000_000n;
export const ACCEPTED_AT = 1_760_000_100n;
export const WORK_DEADLINE = ACCEPTED_AT + WORK_DURATION;
export const VERIFICATION_DEADLINE = WORK_DEADLINE + 86_400n;
export const MERGED_AT = ACCEPTED_AT + 1_000n;

export const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
export const CLIENT = key(11);
export const DEVELOPER = key(12);

const ZERO = new Uint8Array(32);

export function iso(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

/** A Task account in SUBMITTED for the standard pull request. */
export function submittedTask(patch: Partial<TaskAccount> = {}): TaskAccount {
  return {
    taskId: new Uint8Array(16).fill(1),
    client: CLIENT,
    developer: DEVELOPER,
    amount: AMOUNT,
    feeBps: 250,
    termsHash: termsHash({
      repo: REPO,
      acceptanceCriteria: CRITERIA,
      workDuration: WORK_DURATION,
      amount: AMOUNT,
    }),
    state: 'SUBMITTED',
    outcome: 'NONE',
    workDuration: WORK_DURATION,
    createdAt: CREATED_AT,
    acceptedAt: ACCEPTED_AT,
    workDeadline: WORK_DEADLINE,
    verificationDeadline: VERIFICATION_DEADLINE,
    submissionNonce: 1n,
    evidenceHash: evidenceHash({ repo: REPO, prNumber: PR_NUMBER, headSha: HEAD_SHA }),
    submittedAt: ACCEPTED_AT + 1_500n,
    disputeOpenAt: VERIFICATION_DEADLINE,
    refundOpenAt: VERIFICATION_DEADLINE + 172_800n,
    attestedNonce: 0n,
    attestedHash: ZERO,
    verifiedAt: 0n,
    reviewDeadline: 0n,
    disputedAt: 0n,
    disputeDeadline: 0n,
    rejectionReasonHash: ZERO,
    closedAt: 0n,
    bump: 255,
    escrowBump: 255,
    ...patch,
  };
}

export const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';

/** A head commit that declares it is for `taskId` and pays `wallet`. */
export function headCommit(
  taskId: string = TASK_ID,
  wallet: string = DEVELOPER.toBase58(),
): Commit {
  return {
    sha: HEAD_SHA,
    message: `Add the transaction parser\n\nParses signatures into structured output.\n\n${requiredTrailers(taskId, wallet)}\n`,
  };
}

/** A pull request that satisfies every rule for `submittedTask()`. */
export function mergedPullRequest(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    number: Number(PR_NUMBER),
    merged: true,
    mergedAt: iso(MERGED_AT),
    headSha: HEAD_SHA,
    mergeCommitSha: MERGE_SHA,
    author: { id: DEVELOPER_GITHUB_ID, login: 'dev-octocat' },
    mergedBy: { id: MAINTAINER_GITHUB_ID, login: 'maintainer' },
    baseRepo: 'Octo-Org/Parser',
    baseRepoCreatedAt: '2020-01-01T00:00:00Z',
    ...patch,
  };
}
