// End-to-end verification of the whole system against a local validator:
//
//   wallet -> API (HTTP) -> PostgreSQL
//      |                        ^
//      v                        |
//   Solana program <- attestation service <- GitHub (fake, in this harness only)
//
// Started by scripts/e2e.sh, which builds the program and runs the validator.
// Every transaction is real: built by the SDK, signed by a test wallet, executed
// by the deployed program, and only then reported to the API.

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createTransferInstruction } from '@solana/spl-token';
import { Keypair, type PublicKey, SystemProgram } from '@solana/web3.js';
import {
  acceptTask,
  approveTask,
  cancelTask,
  createAndFundTask,
  createUsdcAccountIdempotent,
  evidenceHash,
  evidenceTrailers,
  expireDispute,
  expireReview,
  fetchChainTime,
  fetchTokenAmount,
  findAssociatedTokenAddress,
  findEscrowAddress,
  findTaskAddress,
  fromHex,
  openDeveloperDispute,
  rejectionReasonHash,
  rejectTask,
  submitWork,
  taskIdFromUuid,
  termsHash,
  toHex,
} from '@taskra/sdk';
import { expectRejection, send } from '../../../packages/sdk/e2e/lib.js';
import { Actor, type TaskView } from './actor.js';
import { check, checkTrue, note, passedChecks, section, until } from './check.js';
import type { FakeUser } from './fake-github.js';
import { createWorld, WEB_ORIGIN, type World } from './world.js';

const AMOUNT = 100_000_000n; // 100 USDC
const FEE = 2_500_000n;
const REPO = 'octo-org/parser';
const CRITERIA = 'Parses transaction signatures\nReturns structured output';
const MAINTAINER: FakeUser = { id: 9_000, login: 'maintainer' };

const world = await createWorld();
world.github.addRepository(REPO);
let nextPullNumber = 100n;
let nextUserId = 1_000;

interface Party {
  readonly client: Actor;
  readonly developer: Actor;
  readonly developerUser: FakeUser;
}

/** A funded client and a developer with a linked GitHub identity, both signed in. */
async function party(label: string): Promise<Party> {
  const client = await new Actor(world, `${label} client`).prepare();
  const developer = await new Actor(world, `${label} developer`).prepare();
  await world.fundUsdc(client.publicKey, AMOUNT);
  await client.signIn();
  await developer.signIn();
  nextUserId += 1;
  const developerUser = { id: nextUserId, login: `dev-${String(nextUserId)}` };
  const landed = await developer.linkGithub(developerUser);
  check('GitHub identity linked through the OAuth flow', landed?.endsWith('github=linked'), true);
  return { client, developer, developerUser };
}

function usdc(owner: PublicKey): Promise<bigint> {
  return fetchTokenAmount(
    world.connection,
    findAssociatedTokenAddress(owner, world.config.usdcMint),
    'finalized',
  ).then((amount) => amount ?? 0n);
}

function chainTime(): Promise<bigint> {
  return fetchChainTime(world.connection, 'confirmed');
}

async function waitForChainTimeAfter(deadline: string | null | undefined, what: string) {
  if (deadline == null) throw new Error(`${what} is not set on the task`);
  await until(`chain clock passed ${what}`, chainTime, (now) => now > BigInt(deadline));
}

interface Funded {
  readonly id: string;
  readonly address: PublicKey;
}

/** T0 + T1: draft through the API, then create_and_fund_task signed by the client. */
async function fundTask(client: Actor, workDuration: bigint): Promise<Funded> {
  const draft = await client.call<{ task: TaskView }>('POST', '/api/v1/tasks', {
    title: 'Build a Solana transaction parser',
    description: 'Parse a transaction signature into structured output.',
    repo: REPO,
    acceptanceCriteria: CRITERIA,
    workDuration: workDuration.toString(),
    amount: AMOUNT.toString(),
  });
  check('draft is DRAFT', draft.task.state, 'DRAFT');
  // The wallet recomputes the terms hash and the address; it does not take the API's word.
  const hash = termsHash({
    repo: REPO,
    acceptanceCriteria: CRITERIA,
    workDuration,
    amount: AMOUNT,
  });
  check('API terms hash equals the SDK hash', draft.task.termsHash, toHex(hash));
  const taskId = taskIdFromUuid(draft.task.id);
  const address = findTaskAddress(world.config.programId, client.publicKey, taskId)[0];
  check('API task address equals the SDK derivation', draft.task.taskAddress, address.toBase58());

  const signature = await client.send([
    createAndFundTask(world.config, {
      client: client.publicKey,
      taskId,
      amount: AMOUNT,
      workDuration,
      termsHash: hash,
    }),
  ]);
  const reported = await client.report(draft.task.id, 'fund', { signature });
  check(
    'funding recognised as create_and_fund_task',
    reported.transaction.instruction,
    'create_and_fund_task',
  );
  check('task is OPEN after funding', reported.task.state, 'OPEN');
  check('on-chain terms match the stored metadata', reported.task.termsVerified, true);
  return { id: draft.task.id, address };
}

async function accept(p: Party, task: Funded): Promise<void> {
  const signature = await p.developer.send([
    acceptTask(world.config, { developer: p.developer.publicKey, task: task.address }),
  ]);
  const reported = await p.developer.report(task.id, 'accept', { signature });
  check('task is ACCEPTED', reported.task.state, 'ACCEPTED');
  check('developer recorded from the chain', reported.task.developerWallet, p.developer.address);
}

/** Opens a pull request on the fake GitHub, records its hash on-chain and registers it. */
async function submit(
  p: Party,
  task: Funded,
  options: { merged: boolean; unrelated?: boolean },
): Promise<{ prNumber: bigint; hash: Uint8Array }> {
  nextPullNumber += 1n;
  const prNumber = nextPullNumber;
  const headSha =
    toHex(p.developer.keypair.publicKey.toBytes()).slice(0, 24) +
    prNumber.toString(16).padStart(16, '0');
  const mergedAt = new Date(Number((await chainTime()) + 1n) * 1000).toISOString();
  world.github.setPull(REPO, prNumber, {
    merged: options.merged,
    mergedAt: options.merged ? mergedAt.replace('.000Z', 'Z') : null,
    mergeCommitSha: options.merged ? 'c'.repeat(40) : null,
    headSha,
    // A pull request made for this task says so in its final commit. An
    // unrelated one (the M-01 scenario) is a perfectly good merged pull request
    // that says nothing about any task.
    headMessage:
      options.unrelated === true
        ? 'Fix a typo in the README'
        : `Add the parser\n\n${evidenceTrailers(task.id, p.developer.address)}\n`,
    author: p.developerUser,
    mergedBy: options.merged ? MAINTAINER : null,
  });
  const hash = evidenceHash({ repo: REPO, prNumber, headSha });
  const signature = await p.developer.send([
    submitWork(world.config, {
      developer: p.developer.publicKey,
      task: task.address,
      evidenceHash: hash,
    }),
  ]);
  const registered = await p.developer.call<{ task: TaskView }>(
    'POST',
    `/api/v1/tasks/${task.id}/evidence`,
    { prNumber: Number(prNumber), signature },
  );
  check('task is SUBMITTED', registered.task.state, 'SUBMITTED');
  check('evidence hash read from the chain', registered.task.chain?.evidenceHash, toHex(hash));
  return { prNumber, hash };
}

/** Waits until the latest submission has been attested on-chain. */
function waitForAttestation(viewer: Actor, task: Funded): Promise<TaskView> {
  return until(
    'submission VERIFIED and task UNDER_REVIEW',
    () => viewer.task(task.id),
    (view) =>
      view.verification[0]?.status === 'VERIFIED' && view.chain?.hasValidAttestation === true,
  );
}

function waitForSettlement(viewer: Actor, task: Funded): Promise<TaskView> {
  return until(
    'settlement recorded (finalized)',
    () => viewer.task(task.id),
    (view) => view.settlement !== null,
  );
}

async function count(sql: string, parameters: readonly unknown[]): Promise<number> {
  const result = await world.owner.query<{ count: string }>(sql, [...parameters]);
  return Number(result.rows[0]?.count ?? -1);
}

function settlementParties(p: Party, task: Funded) {
  return {
    task: task.address,
    client: p.client.publicKey,
    developer: p.developer.publicKey,
    treasury: world.platform.treasury,
  };
}

// --- A: the full successful lifecycle ---------------------------------------

async function scenarioApprove(): Promise<{
  party: Party;
  task: Funded;
  approveSignature: string;
}> {
  section('A. create -> fund -> accept -> submit -> verify -> attest -> approve -> settle');
  const p = await party('A');
  const session = await p.developer.call<{ github: { login: string } | null }>(
    'GET',
    '/api/v1/auth/session',
  );
  check('session shows the linked GitHub login', session.github?.login, p.developerUser.login);

  const before = {
    developer: await usdc(p.developer.publicKey),
    treasury:
      (await fetchTokenAmount(world.connection, world.platform.treasury, 'finalized')) ?? 0n,
  };
  const task = await fundTask(p.client, 600n);

  // A repeated report is harmless.
  const [funding] = (await p.client.task(task.id)).transactions;
  await p.client.report(task.id, 'fund', { signature: funding?.signature });
  check(
    'duplicate funding report left one transaction row',
    await count(`SELECT count(*) FROM onchain_transactions WHERE task_id = $1`, [task.id]),
    1,
  );

  await accept(p, task);
  const { hash } = await submit(p, task, { merged: true });

  // The test profile's review window is 10 s, so the client approves as soon
  // as the attestation is visible; its finality is checked after settlement.
  const attested = await waitForAttestation(p.client, task);
  const [verification] = attested.verification;
  check('verification is VERIFIED', verification?.status, 'VERIFIED');
  check(
    'every rule passed',
    verification?.result?.rules.every((rule) => rule.passed === true),
    true,
  );
  check('audit record keeps the head SHA', verification?.result?.headSha?.length, 40);
  check(
    'audit record keeps the merge commit SHA',
    verification?.result?.mergeCommitSha,
    'c'.repeat(40),
  );
  check('task is UNDER_REVIEW', attested.chain?.state, 'UNDER_REVIEW');
  check('attestation is valid on-chain', attested.chain?.hasValidAttestation, true);
  check(
    'exactly one attestation operation for the submission',
    await count(`SELECT count(*) FROM attestations WHERE task_id = $1`, [task.id]),
    1,
  );

  const approve = [
    createUsdcAccountIdempotent(world.config, {
      payer: p.client.publicKey,
      owner: p.developer.publicKey,
    }),
    approveTask(world.config, { ...settlementParties(p, task), evidenceHash: hash }),
    // M-02: whoever sends the settlement can add transfers of their own. This one
    // sends one extra base unit to the developer in the same transaction. Before
    // the fix the API then refused to record the settlement at all.
    createTransferInstruction(
      findAssociatedTokenAddress(p.client.publicKey, world.config.usdcMint),
      findAssociatedTokenAddress(p.developer.publicKey, world.config.usdcMint),
      p.client.publicKey,
      1n,
    ),
  ];
  await world.fundUsdc(p.client.publicKey, 1n);
  const approveSignature = await p.client.send(approve);
  const reported = await p.client.report(task.id, 'approve', { signature: approveSignature });
  checkTrue(
    'approval is reported as confirmed or finalized, never earlier',
    ['CONFIRMED', 'FINALIZED'].includes(reported.transaction.status),
  );
  if (reported.transaction.status === 'CONFIRMED') {
    check('no settlement is recorded before finality', reported.task.settlement, null);
  }

  const settled = await waitForSettlement(p.client, task);
  check('settlement outcome', settled.settlement?.outcome, 'APPROVED');
  check('settlement transaction', settled.settlement?.signature, approveSignature);
  check('fee observed on-chain: 2.50 USDC', settled.settlement?.feeAmount, FEE.toString());
  check(
    'developer observed on-chain: 97.50 USDC',
    settled.settlement?.developerAmount,
    (AMOUNT - FEE).toString(),
  );
  check(
    'developer balance grew by 97.50 USDC plus the one unrelated unit',
    (await usdc(p.developer.publicKey)) - before.developer,
    AMOUNT - FEE + 1n,
  );
  check(
    'treasury balance grew by 2.50 USDC',
    ((await fetchTokenAmount(world.connection, world.platform.treasury, 'finalized')) ?? 0n) -
      before.treasury,
    FEE,
  );

  const finalAttestation = await until(
    'attestation record FINALIZED',
    () => p.client.task(task.id),
    (view) => view.verification[0]?.attestation?.status === 'FINALIZED',
  );
  checkTrue(
    'attestation transaction signature is recorded',
    (finalAttestation.verification[0]?.attestation?.signature ?? '').length > 60,
  );

  const reputation = await p.client.call<{
    developer: { tasksSettled: number; totalEarned: string; distinctClients: number };
    reliableContributor: { label: string; qualified: boolean };
  }>('GET', `/api/v1/users/${p.developer.address}/reputation`);
  check('reputation: one settled task', reputation.developer.tasksSettled, 1);
  check('reputation: total earned', reputation.developer.totalEarned, (AMOUNT - FEE).toString());
  check(
    'reputation milestone is labelled off-chain',
    reputation.reliableContributor.label,
    'Off-chain aggregate',
  );

  // Invalid transition: the task is terminal.
  const refusal = await p.client.sendExpectingRefusal([
    approveTask(world.config, { ...settlementParties(p, task), evidenceHash: hash }),
  ]);
  note(`second approve_task refused by the cluster: ${refusal}`);
  // The same transaction forced on-chain fails there, and is recorded as failed.
  const failedSignature = await p.client.send(
    [approveTask(world.config, { ...settlementParties(p, task), evidenceHash: hash })],
    { skipPreflight: true },
  );
  const failed = await p.client.report(task.id, 'transactions', { signature: failedSignature });
  check('a failed transaction is recorded as FAILED', failed.transaction.status, 'FAILED');
  checkTrue('with a decoded reason', failed.transaction.error !== null);
  check(
    'still exactly one settlement',
    await count(`SELECT count(*) FROM settlements WHERE task_id = $1`, [task.id]),
    1,
  );
  return { party: p, task, approveSignature };
}

// --- B: review expiry, with nobody reporting the outcome ---------------------

async function scenarioReviewExpiry(): Promise<void> {
  section('B. ... -> attest -> review window passes -> expire_review (unreported)');
  const p = await party('B');
  const task = await fundTask(p.client, 600n);
  await accept(p, task);
  await submit(p, task, { merged: true });
  const attested = await waitForAttestation(p.client, task);

  const instruction = expireReview(world.config, settlementParties(p, task));
  const setup = createUsdcAccountIdempotent(world.config, {
    payer: world.cranker.publicKey,
    owner: p.developer.publicKey,
  });
  await send(
    world.connection,
    'create the developer USDC account',
    [setup],
    [world.cranker],
    'confirmed',
  );
  const early = await expectRejection(
    world.connection,
    'expire_review before the deadline',
    [instruction],
    [world.cranker],
  );
  check('expire_review is refused before the review deadline', early, 'ReviewDeadlineNotPassed');

  await waitForChainTimeAfter(attested.chain?.times['reviewDeadline'], 'the review deadline');
  const signature = await send(
    world.connection,
    'expire_review (permissionless, sent by an unrelated wallet)',
    [instruction],
    [world.cranker],
    'finalized',
  );
  // Nobody tells the API. Reading the task is enough.
  const settled = await waitForSettlement(p.developer, task);
  check('API found the outcome transaction by itself', settled.settlement?.signature, signature);
  check('outcome', settled.settlement?.outcome, 'REVIEW_EXPIRED');
  check('developer paid', settled.settlement?.developerAmount, (AMOUNT - FEE).toString());
}

// --- C: cancellation, authorization and mismatched reports -------------------

async function scenarioCancel(other: { task: Funded; approveSignature: string }): Promise<void> {
  section('C. create -> cancel_task; unauthorized and mismatched requests');
  const p = await party('C');
  const task = await fundTask(p.client, 600n);

  // With a token account of its own, the only thing wrong is who is asking.
  await world.fundUsdc(p.developer.publicKey, 0n);
  const unauthorized = await p.developer.sendExpectingRefusal([
    cancelTask(world.config, { client: p.developer.publicKey, task: task.address }),
  ]);
  note(`cancel_task by a wallet that is not the client refused: ${unauthorized}`);
  checkTrue(
    'unauthorized cancellation is refused for who sent it, not for a missing account',
    unauthorized !== '' && unauthorized !== 'AccountNotInitialized',
  );

  // A report must be for this task, and must be a Taskra transaction.
  const wrongTask = await p.client.request<{ error: { code: string } }>(
    'POST',
    `/api/v1/tasks/${task.id}/approve`,
    { signature: other.approveSignature },
  );
  check(
    'a transaction that carries nothing for this task is refused',
    [wrongTask.status, wrongTask.body.error.code],
    [422, 'TRANSACTION_MISMATCH'],
  );
  const transfer = await p.client.send([
    SystemProgram.transfer({
      fromPubkey: p.client.publicKey,
      toPubkey: p.developer.publicKey,
      lamports: 1_000,
    }),
  ]);
  const foreign = await p.client.request<{ error: { code: string } }>(
    'POST',
    `/api/v1/tasks/${task.id}/transactions`,
    { signature: transfer },
  );
  check(
    'a non-Taskra transaction is refused',
    [foreign.status, foreign.body.error.code],
    [422, 'TRANSACTION_MISMATCH'],
  );

  const anonymous = await new Actor(world, 'anonymous').request<{ error: { code: string } }>(
    'POST',
    `/api/v1/tasks/${task.id}/transactions`,
    { signature: transfer },
  );
  check('reporting requires a session', anonymous.status, 401);
  const crossOrigin = await fetch(`${world.apiUrl}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  check('a request from another origin is refused', crossOrigin.status, 403);

  const signature = await p.client.send([
    cancelTask(world.config, { client: p.client.publicKey, task: task.address }),
  ]);
  const reported = await p.client.report(task.id, 'transactions', { signature });
  check('task is CANCELLED', reported.task.state, 'CANCELLED');
  const settled = await waitForSettlement(p.client, task);
  check('outcome', settled.settlement?.outcome, 'CANCELLED');
  check('no fee on a cancellation', settled.settlement?.feeAmount, '0');
  check('client refunded in full', settled.settlement?.clientAmount, AMOUNT.toString());
  check('client balance restored', await usdc(p.client.publicKey), AMOUNT);

  // Insufficient balance: the token program refuses, and nothing exists afterwards.
  const broke = await new Actor(world, 'unfunded client').prepare();
  await world.fundUsdc(broke.publicKey, 0n);
  await broke.signIn();
  const draft = await broke.call<{ task: TaskView }>('POST', '/api/v1/tasks', {
    title: 'Unfunded',
    description: '',
    repo: REPO,
    acceptanceCriteria: CRITERIA,
    workDuration: '600',
    amount: AMOUNT.toString(),
  });
  const refusal = await broke.sendExpectingRefusal([
    createAndFundTask(world.config, {
      client: broke.publicKey,
      taskId: taskIdFromUuid(draft.task.id),
      amount: AMOUNT,
      workDuration: 600n,
      termsHash: fromHex(draft.task.termsHash),
    }),
  ]);
  note(`create_and_fund_task without the funds refused: ${refusal}`);
  check('the draft stays a draft', (await broke.task(draft.task.id)).state, 'DRAFT');
  const hidden = await p.developer.request('GET', `/api/v1/tasks/${draft.task.id}`);
  check("another wallet cannot see someone else's draft", hidden.status, 404);
}

// --- D: rejection, dispute, fallback for an attested submission --------------

async function scenarioRejected(): Promise<void> {
  section('D. ... -> attest -> reject_task -> DISPUTED -> expire_dispute pays the developer');
  const p = await party('D');
  const task = await fundTask(p.client, 600n);
  await accept(p, task);
  await submit(p, task, { merged: true });
  await waitForAttestation(p.client, task);

  const reason = 'The parser does not return structured output.';
  const signature = await p.client.send([
    rejectTask(world.config, {
      client: p.client.publicKey,
      task: task.address,
      reasonHash: rejectionReasonHash(reason),
    }),
  ]);
  const wrong = await p.client.request<{ error: { code: string } }>(
    'POST',
    `/api/v1/tasks/${task.id}/reject`,
    { signature, reason: 'A different reason.' },
  );
  check(
    'a reason that does not match the on-chain hash is refused',
    [wrong.status, wrong.body.error.code],
    [422, 'REASON_MISMATCH'],
  );
  const reported = await p.client.report(task.id, 'reject', { signature, reason });
  check('task is DISPUTED', reported.task.state, 'DISPUTED');
  check('rejection reason is shown', reported.task.rejection?.reason, reason);

  const fallback = expireDispute(world.config, {
    task: task.address,
    client: p.client.publicKey,
    expected: {
      outcome: 'PAY_DEVELOPER',
      developer: p.developer.publicKey,
      treasury: world.platform.treasury,
    },
  });
  await send(
    world.connection,
    'create the developer USDC account',
    [
      createUsdcAccountIdempotent(world.config, {
        payer: world.cranker.publicKey,
        owner: p.developer.publicKey,
      }),
    ],
    [world.cranker],
    'confirmed',
  );
  await waitForChainTimeAfter(
    reported.task.chain?.times['disputeDeadline'],
    'the dispute deadline',
  );
  // Permissionless: sent by a wallet that is neither party.
  const expired = await send(
    world.connection,
    'expire_dispute',
    [fallback],
    [world.cranker],
    'confirmed',
  );
  await p.developer.report(task.id, 'transactions', { signature: expired });
  const settled = await waitForSettlement(p.developer, task);
  check('outcome', settled.settlement?.outcome, 'DISPUTE_EXPIRED_FOR_DEVELOPER');
  check(
    'developer paid, because a valid attestation existed',
    settled.settlement?.developerAmount,
    (AMOUNT - FEE).toString(),
  );
  const reputation = await p.developer.call<{ developer: { tasksDisputed: number } }>(
    'GET',
    `/api/v1/users/${p.developer.address}/reputation`,
  );
  check('the dispute is counted in the reputation', reputation.developer.tasksDisputed, 1);
}

// --- E: evidence that cannot be verified -------------------------------------

async function scenarioUnverified(): Promise<void> {
  section('E. unmerged pull request -> never attested -> developer dispute -> client refunded');
  const p = await party('E');
  const task = await fundTask(p.client, 40n);
  await accept(p, task);

  // GitHub is down when the submission arrives: PENDING, never a verdict.
  world.github.outage = true;
  await submit(p, task, { merged: false });
  await until(
    'a PENDING verification result while GitHub is unavailable',
    () => p.developer.task(task.id),
    (view) =>
      view.verification[0]?.status === 'PENDING' &&
      view.verification[0].result?.rules.some((rule) => rule.rule === 'R10') === true,
  );
  world.github.outage = false;
  const rejected = await until(
    'verification REJECTED once GitHub answers',
    () => p.developer.task(task.id),
    (view) => view.verification[0]?.status === 'REJECTED',
  );
  const failedRules = rejected.verification[0]?.result?.rules
    .filter((rule) => rule.passed === false)
    .map((rule) => rule.rule);
  check('rejected because the pull request is not merged (R4)', failedRules, ['R4']);
  check('no attestation was requested', rejected.verification[0]?.attestation, null);
  check('task stays SUBMITTED', rejected.chain?.state, 'SUBMITTED');

  await waitForChainTimeAfter(
    rejected.chain?.times['disputeOpenAt'],
    'the start of the developer dispute window',
  );
  const signature = await p.developer.send([
    openDeveloperDispute(world.config, { developer: p.developer.publicKey, task: task.address }),
  ]);
  const disputed = await p.developer.report(task.id, 'transactions', { signature });
  check('task is DISPUTED', disputed.task.state, 'DISPUTED');

  await waitForChainTimeAfter(
    disputed.task.chain?.times['disputeDeadline'],
    'the dispute deadline',
  );
  await send(
    world.connection,
    'expire_dispute',
    [
      expireDispute(world.config, {
        task: task.address,
        client: p.client.publicKey,
        expected: { outcome: 'REFUND_CLIENT' },
      }),
    ],
    [world.cranker],
    'finalized',
  );
  const settled = await waitForSettlement(p.client, task);
  check('outcome', settled.settlement?.outcome, 'DISPUTE_EXPIRED_FOR_CLIENT');
  check('client refunded in full', settled.settlement?.clientAmount, AMOUNT.toString());
  check('developer received nothing', settled.settlement?.developerAmount, '0');
  check('client balance restored', await usdc(p.client.publicKey), AMOUNT);
  check(
    'no attestation exists for a task that was never verified',
    await count(`SELECT count(*) FROM attestations WHERE task_id = $1`, [task.id]),
    0,
  );
}

// --- F: resubmission, stale attestations, tampered metadata ------------------

async function scenarioResubmission(): Promise<void> {
  section('F. resubmission voids the attestation; replayed jobs and tampered metadata');
  const p = await party('F');
  const task = await fundTask(p.client, 600n);
  await accept(p, task);
  const first = await submit(p, task, { merged: true });
  await waitForAttestation(p.client, task);

  const second = await submit(p, task, { merged: true });
  const resubmitted = await p.client.task(task.id);
  check('submission nonce advanced', resubmitted.chain?.submissionNonce, '2');
  check('the earlier attestation no longer applies', resubmitted.chain?.hasValidAttestation, false);

  const stale = await p.client.sendExpectingRefusal([
    createUsdcAccountIdempotent(world.config, {
      payer: p.client.publicKey,
      owner: p.developer.publicKey,
    }),
    approveTask(world.config, { ...settlementParties(p, task), evidenceHash: first.hash }),
  ]);
  check('approving the superseded evidence is refused', stale, 'EvidenceMismatch');

  const reattested = await waitForAttestation(p.client, task);
  check('the new submission is the one verified', reattested.verification[0]?.submissionNonce, '2');
  check(
    'one attestation operation per submission',
    await count(`SELECT count(*) FROM attestations WHERE task_id = $1`, [task.id]),
    2,
  );

  const signature = await p.client.send([
    createUsdcAccountIdempotent(world.config, {
      payer: p.client.publicKey,
      owner: p.developer.publicKey,
    }),
    approveTask(world.config, { ...settlementParties(p, task), evidenceHash: second.hash }),
  ]);
  await p.client.report(task.id, 'approve', { signature });
  const settled = await waitForSettlement(p.client, task);
  check('outcome', settled.settlement?.outcome, 'APPROVED');

  // Replay the old job: nothing may be sent for a superseded submission.
  const sentBefore = await count(
    `SELECT coalesce(sum(attempts), 0) AS count FROM attestations WHERE task_id = $1`,
    [task.id],
  );
  await world.owner.query(
    `UPDATE verification_jobs SET status = 'QUEUED', run_after = now()
      WHERE submission_id IN (SELECT id FROM submissions WHERE task_id = $1)`,
    [task.id],
  );
  await until(
    'replayed jobs processed',
    () =>
      count(
        `SELECT count(*) FROM verification_jobs j JOIN submissions s ON s.id = j.submission_id WHERE s.task_id = $1 AND j.status <> 'DONE'`,
        [task.id],
      ),
    (open) => open === 0,
  );
  check(
    'replayed jobs sent no further attestation',
    await count(`SELECT coalesce(sum(attempts), 0) AS count FROM attestations WHERE task_id = $1`, [
      task.id,
    ]),
    sentBefore,
  );

  // Someone with database access rewrites the repository.
  await world.owner.query(`UPDATE tasks SET repo = 'attacker/repo' WHERE id = $1`, [task.id]);
  const tampered = await p.client.task(task.id);
  check('tampered metadata is flagged as unverified', tampered.termsVerified, false);
  check('the chain is unaffected', tampered.chain?.state, 'SETTLED');
  await world.owner.query(`UPDATE tasks SET repo = $2 WHERE id = $1`, [task.id, REPO]);
}

// --- H: a pull request that was not made for the task ------------------------

async function scenarioUnrelatedPullRequest(): Promise<void> {
  section('H. an unrelated merged pull request cannot satisfy a task (M-01)');
  const p = await party('H');
  const task = await fundTask(p.client, 600n);
  await accept(p, task);

  // Merged by a maintainer, written by the developer, right repository, inside
  // the work window, hash correct: every rule that existed before passes.
  await submit(p, task, { merged: true, unrelated: true });
  const rejected = await until(
    'verification REJECTED for the unrelated pull request',
    () => p.developer.task(task.id),
    (view) => view.verification[0]?.status === 'REJECTED',
  );
  const rules = new Map(
    rejected.verification[0]?.result?.rules.map((rule) => [rule.rule, rule.passed]),
  );
  check(
    'every earlier rule (R1-R9) passes for it',
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].every(
      (rule) => rules.get(rule) === true,
    ),
    true,
  );
  check('it is rejected for not naming the task (R11)', rules.get('R11'), false);
  check('and for not naming the developer wallet (R12)', rules.get('R12'), false);
  check('no attestation was requested', rejected.verification[0]?.attestation, null);
  check('the task is still SUBMITTED', rejected.chain?.state, 'SUBMITTED');
  check('no valid attestation on-chain', rejected.chain?.hasValidAttestation, false);

  // The developer then submits a pull request that is for this task.
  await submit(p, task, { merged: true });
  const attested = await waitForAttestation(p.developer, task);
  check(
    'a pull request made for the task is verified',
    attested.verification[0]?.status,
    'VERIFIED',
  );
  check(
    'one attestation for the task: the unrelated submission never got one',
    await count(`SELECT count(*) FROM attestations WHERE task_id = $1`, [task.id]),
    1,
  );
}

// --- G: the services as real processes ---------------------------------------

// --- I: one transaction, two tasks and a deposit -----------------------------

async function scenarioComposedSettlement(): Promise<void> {
  section('I. one transaction settles two tasks and carries a deposit (N-1, N-3)');
  const p = await party('I');
  // 1,000,000 USDC, deposited into the escrow of a 100 USDC task.
  const DEPOSIT = 1_000_000_000_000n;
  await world.fundUsdc(p.client.publicKey, AMOUNT + DEPOSIT);
  const paid = await fundTask(p.client, 600n);
  const withdrawn = await fundTask(p.client, 600n);
  await accept(p, paid);
  const { hash } = await submit(p, paid, { merged: true });

  const clientToken = findAssociatedTokenAddress(p.client.publicKey, world.config.usdcMint);
  const before = {
    developer: await usdc(p.developer.publicKey),
    client: (await fetchTokenAmount(world.connection, clientToken, 'confirmed')) ?? 0n,
  };
  // Everything the sender of a settlement can add to it, in one real
  // transaction: a deposit into the escrow, the outcome of a second task, and
  // so a second top-level Taskra instruction. Before the fixes the API recorded
  // neither settlement, and would have counted the deposit as earnings.
  const signature = await p.client.send([
    createUsdcAccountIdempotent(world.config, {
      payer: p.client.publicKey,
      owner: p.developer.publicKey,
    }),
    createTransferInstruction(
      clientToken,
      findEscrowAddress(world.config.programId, paid.address)[0],
      p.client.publicKey,
      DEPOSIT,
    ),
    approveTask(world.config, { ...settlementParties(p, paid), evidenceHash: hash }),
    cancelTask(world.config, { client: p.client.publicKey, task: withdrawn.address }),
  ]);

  const approved = await p.client.report(paid.id, 'approve', { signature });
  check(
    'the report names approve_task for the first task',
    approved.transaction.instruction,
    'approve_task',
  );
  const cancelled = await p.client.report(withdrawn.id, 'transactions', { signature });
  check(
    'the same signature names cancel_task for the second task',
    cancelled.transaction.instruction,
    'cancel_task',
  );

  const settled = await waitForSettlement(p.client, paid);
  check('first task: settled by that transaction', settled.settlement?.signature, signature);
  check('first task: outcome', settled.settlement?.outcome, 'APPROVED');
  check('first task: fee is the task fee', settled.settlement?.feeAmount, FEE.toString());
  check(
    'first task: earnings are the task amount less the fee, not the deposit',
    settled.settlement?.developerAmount,
    (AMOUNT - FEE).toString(),
  );
  check(
    'yet the developer really received the deposit as well',
    (await usdc(p.developer.publicKey)) - before.developer,
    AMOUNT - FEE + DEPOSIT,
  );

  const refunded = await waitForSettlement(p.client, withdrawn);
  check('second task: settled by the same transaction', refunded.settlement?.signature, signature);
  check('second task: outcome', refunded.settlement?.outcome, 'CANCELLED');
  check(
    'second task: client refunded the task amount',
    refunded.settlement?.clientAmount,
    AMOUNT.toString(),
  );
  check(
    'the client got one task back and paid the deposit',
    ((await fetchTokenAmount(world.connection, clientToken, 'finalized')) ?? 0n) - before.client,
    AMOUNT - DEPOSIT,
  );

  check(
    'two settlements name the one transaction',
    await count(`SELECT count(*) FROM settlements WHERE signature = $1`, [signature]),
    2,
  );
  check(
    'recorded once per task',
    await count(`SELECT count(*) FROM onchain_transactions WHERE signature = $1`, [signature]),
    2,
  );
  // Read again and report again: nothing is credited twice.
  await p.client.report(paid.id, 'approve', { signature });
  await p.developer.task(paid.id);
  const reputation = await p.client.call<{
    developer: { tasksSettled: number; totalEarned: string };
  }>('GET', `/api/v1/users/${p.developer.address}/reputation`);
  check('reputation: one settled task', reputation.developer.tasksSettled, 1);
  check(
    'reputation: 97.50 USDC earned, not 1,000,097.50',
    reputation.developer.totalEarned,
    (AMOUNT - FEE).toString(),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

function start(
  app: 'api' | 'attester',
  env: Record<string, string>,
): { child: ChildProcess; output: () => string } {
  const cwd = fileURLToPath(new URL(`../../${app}`, import.meta.url));
  let output = '';
  // A minimal environment: nothing leaks in from the shell that runs the suite.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function scenarioProcesses(w: World): Promise<void> {
  section('G. the API and the attestation service as separate processes');
  const chainEnv = {
    SOLANA_NETWORK: 'localnet',
    SOLANA_RPC_URL: w.rpcUrl,
    TASKRA_PROGRAM_ID: w.config.programId.toBase58(),
    USDC_MINT: w.config.usdcMint.toBase58(),
  };
  const port = await freePort();
  const api = start('api', {
    ...chainEnv,
    NODE_ENV: 'development',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    WEB_ORIGIN,
    DATABASE_URL: w.databaseUrls.api,
  });
  const attester = start('attester', {
    ...chainEnv,
    NODE_ENV: 'development',
    DATABASE_URL: w.databaseUrls.attester,
    ATTESTER_SECRET_KEY: w.attesterSecretKey,
  });
  try {
    const ready = await until(
      'API process ready',
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/ready`);
          return { status: response.status, body: await response.json() };
        } catch {
          return { status: 0, body: null };
        }
      },
      (value) => value.status === 200,
      60_000,
    );
    check('GET /ready', ready.body, { status: 'ready', checks: { database: 'ok', rpc: 'ok' } });
    const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
    check('GET /health', await health.json(), { status: 'ok' });
    const tasks = await fetch(`http://127.0.0.1:${String(port)}/api/v1/tasks?limit=1`);
    check('the API process serves tasks from its own database login', tasks.status, 200);

    await until(
      'attester process started',
      () => Promise.resolve(attester.output()),
      (text) => text.includes('attester started'),
      60_000,
    );
    checkTrue(
      'the attester logs its public key, never its secret',
      !attester.output().includes(w.attesterSecretKey.slice(1, 60)),
    );
    checkTrue(
      'the API process log contains no secret',
      !api.output().includes(w.attesterSecretKey.slice(1, 60)),
    );
  } finally {
    api.child.kill('SIGTERM');
    attester.child.kill('SIGTERM');
    await Promise.all([exitCode(api.child), exitCode(attester.child)]);
  }

  // A key the platform does not name must not be allowed to run.
  const wrongKey = JSON.stringify([...Keypair.generate().secretKey]);
  const refused = start('attester', {
    ...chainEnv,
    NODE_ENV: 'development',
    DATABASE_URL: w.databaseUrls.attester,
    ATTESTER_SECRET_KEY: wrongKey,
  });
  check(
    'the attester refuses to start with a key the platform does not name',
    await exitCode(refused.child),
    1,
  );
  checkTrue('and says why', refused.output().includes('refusing to start'));

  // The API's database login cannot write what only the attester may write.
  const denied = await w.owner.query<{ allowed: boolean }>(
    `SELECT has_table_privilege(r.rolname, 'attestations', 'INSERT')
            OR has_table_privilege(r.rolname, 'verification_results', 'INSERT') AS allowed
       FROM pg_roles r WHERE r.rolname = $1`,
    [new URL(w.databaseUrls.api).username],
  );
  check(
    "the API's database login cannot write results or attestations",
    denied.rows[0]?.allowed,
    false,
  );
}

let failure: unknown;
try {
  const approved = await scenarioApprove();
  await scenarioReviewExpiry();
  await scenarioCancel(approved);
  await scenarioRejected();
  await scenarioUnverified();
  await scenarioResubmission();
  await scenarioUnrelatedPullRequest();
  await scenarioComposedSettlement();
  await scenarioProcesses(world);
} catch (error) {
  failure = error;
} finally {
  await world.stop();
}
if (failure !== undefined) {
  console.error(`\nEND-TO-END RUN FAILED after ${String(passedChecks())} checks`);
  console.error(failure);
  process.exit(1);
}
console.log(`\nEND-TO-END RUN PASSED: ${String(passedChecks())} checks`);
process.exit(0);
