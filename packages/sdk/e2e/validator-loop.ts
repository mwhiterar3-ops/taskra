// End-to-end exit criterion for the SDK. Runs against a local
// solana-test-validator (started by scripts/validator-loop.sh) with a real SPL
// mint and a short-window test profile. Every Taskra instruction, address,
// account decode, hash and fee expectation below comes from the SDK.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMint, mintTo } from '@solana/spl-token';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import {
  acceptTask,
  approveTask,
  cancelTask,
  commitmentFor,
  computeTimeline,
  createAndFundTask,
  createTaskraConfig,
  createUsdcAccountIdempotent,
  currentSubmission,
  evidenceHash,
  expireDispute,
  expireReview,
  fetchChainTime,
  fetchPlatform,
  fetchTask,
  fetchTokenAmount,
  findAssociatedTokenAddress,
  findEscrowAddress,
  findTaskAddress,
  hasValidAttestation,
  matchesCurrentSubmission,
  type Outcome,
  openDeveloperDispute,
  type PlatformAccount,
  recordAttestation,
  rejectTask,
  splitSettlement,
  submitWork,
  type TaskAccount,
  type TaskraCommitment,
  type TaskraConfig,
  type TaskState,
  taskIdFromUuid,
  termsHash,
  toHex,
} from '../src/index.js';
import { airdrop, expectRejection, loadKeypair, requireEnv, send } from './lib.js';

// Short-window test profile: seconds instead of hours and days.
const TEST_PROFILE = {
  feeBps: 250,
  reviewWindow: 10n,
  verificationGrace: 5n,
  disputeTimeout: 8n,
};
const AMOUNT = 100_000_000n; // 100 USDC
const REPO = 'octo-org/parser';
const CRITERIA = 'Parses transaction signatures\nReturns structured output';

const PROGRESS = commitmentFor('ui-progress');
const SETTLEMENT = commitmentFor('settlement-record');

const rpcUrl = requireEnv('RPC_URL');
const upgradeAuthorityPath = requireEnv('TASKRA_UPGRADE_AUTHORITY_KEYPAIR');
const connection = new Connection(rpcUrl, 'confirmed');

const upgradeAuthority = loadKeypair(upgradeAuthorityPath);
const authority = Keypair.generate();
const attester = Keypair.generate();
const treasuryOwner = Keypair.generate();
const mintAuthority = Keypair.generate();
const client = Keypair.generate();
const developer = Keypair.generate();
const cranker = Keypair.generate();

function usdc(amount: bigint | null): string {
  if (amount === null) return '(closed)'.padStart(14);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${fraction}`.padStart(14);
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${what}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
  console.log(`      ok: ${what}`);
}

interface Balances {
  readonly client: bigint;
  readonly developer: bigint;
  readonly treasury: bigint;
  readonly escrow: bigint | null;
}

interface Context {
  readonly config: TaskraConfig;
  readonly platform: PlatformAccount;
}

async function balances(
  context: Context,
  task: PublicKey | null,
  commitment: TaskraCommitment,
): Promise<Balances> {
  const { config, platform } = context;
  const own = (owner: PublicKey) => findAssociatedTokenAddress(owner, config.usdcMint);
  const read = (address: PublicKey) => fetchTokenAmount(connection, address, commitment);
  return {
    client: (await read(own(client.publicKey))) ?? 0n,
    developer: (await read(own(developer.publicKey))) ?? 0n,
    treasury: (await read(platform.treasury)) ?? 0n,
    escrow: task === null ? null : await read(findEscrowAddress(config.programId, task)[0]),
  };
}

function printBalances(label: string, commitment: TaskraCommitment, value: Balances): void {
  console.log(`  balances ${label} (USDC, read at ${commitment})`);
  console.log(`      client     ${usdc(value.client)}`);
  console.log(`      developer  ${usdc(value.developer)}`);
  console.log(`      treasury   ${usdc(value.treasury)}`);
  console.log(`      escrow     ${usdc(value.escrow)}`);
}

async function readTask(
  context: Context,
  task: PublicKey,
  commitment: TaskraCommitment,
): Promise<TaskAccount> {
  const account = await fetchTask(connection, context.config, task, commitment);
  if (account === null) throw new Error(`task ${task.toBase58()} does not exist`);
  return account;
}

/** Waits for the cluster clock, which is what the program compares deadlines to. */
async function waitUntilAfter(deadline: bigint, what: string): Promise<void> {
  const started = await fetchChainTime(connection, PROGRESS);
  let now = started;
  while (now <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    now = await fetchChainTime(connection, PROGRESS);
  }
  console.log(
    `  waited for real validator time to pass ${what} ` +
      `(${String(deadline)}): chain time ${String(started)} -> ${String(now)}`,
  );
}

let prCounter = 40n;

/** create_and_fund_task, then optionally accept_task and submit_work. */
async function openTask(
  context: Context,
  workDuration: bigint,
  upTo: 'created' | 'submitted',
): Promise<PublicKey> {
  const { config } = context;
  const uuid = randomUUID();
  const taskId = taskIdFromUuid(uuid);
  const task = findTaskAddress(config.programId, client.publicKey, taskId)[0];
  console.log(`  task ${uuid} -> ${task.toBase58()}`);

  await send(
    connection,
    'create_and_fund_task',
    [
      createAndFundTask(config, {
        client: client.publicKey,
        taskId,
        amount: AMOUNT,
        workDuration,
        termsHash: termsHash({
          repo: REPO,
          acceptanceCriteria: CRITERIA,
          workDuration,
          amount: AMOUNT,
        }),
      }),
    ],
    [client],
    PROGRESS,
  );
  if (upTo === 'created') return task;

  await send(
    connection,
    'accept_task',
    [acceptTask(config, { developer: developer.publicKey, task })],
    [developer],
    PROGRESS,
  );
  prCounter += 1n;
  const hash = evidenceHash({
    repo: REPO,
    prNumber: prCounter,
    headSha: toHex(Keypair.generate().publicKey.toBytes()).slice(0, 40),
  });
  await send(
    connection,
    'submit_work',
    [submitWork(config, { developer: developer.publicKey, task, evidenceHash: hash })],
    [developer],
    PROGRESS,
  );
  return task;
}

/** record_attestation for exactly the submission currently on the task. */
async function attest(context: Context, task: PublicKey): Promise<TaskAccount> {
  const submission = currentSubmission(await readTask(context, task, PROGRESS));
  if (submission === null) throw new Error('nothing has been submitted');
  await send(
    connection,
    'record_attestation',
    [recordAttestation(context.config, { attester: attester.publicKey, task, ...submission })],
    [attester],
    PROGRESS,
  );
  const attested = await readTask(context, task, PROGRESS);
  assertEqual(attested.state, 'UNDER_REVIEW', 'task is UNDER_REVIEW after the attestation');
  assertEqual(matchesCurrentSubmission(attested, submission), true, 'attestation is current');
  return attested;
}

function settlementParties(context: Context, task: PublicKey) {
  return {
    task,
    client: client.publicKey,
    developer: developer.publicKey,
    treasury: context.platform.treasury,
  };
}

/** Assertions shared by every loop, read at the settlement commitment. */
async function assertOutcome(
  context: Context,
  task: PublicKey,
  before: Balances,
  expected: { state: TaskState; outcome: Outcome; paid: 'developer' | 'client' },
): Promise<void> {
  const after = await balances(context, task, SETTLEMENT);
  printBalances('after', SETTLEMENT, after);
  const { fee, developerAmount } = splitSettlement(AMOUNT, context.platform.feeBps);

  if (expected.paid === 'developer') {
    assertEqual(
      after.developer - before.developer,
      developerAmount,
      'developer received amount - fee',
    );
    assertEqual(after.treasury - before.treasury, fee, 'treasury received the fee');
    assertEqual(after.client - before.client, -AMOUNT, 'client paid the amount');
  } else {
    assertEqual(after.client - before.client, 0n, 'client was refunded in full');
    assertEqual(after.developer - before.developer, 0n, 'developer received nothing');
    assertEqual(after.treasury - before.treasury, 0n, 'treasury received nothing');
  }
  assertEqual(after.escrow, null, 'escrow token account is closed');

  const account = await readTask(context, task, SETTLEMENT);
  assertEqual(account.state, expected.state, `task account remains, in state ${expected.state}`);
  assertEqual(account.outcome, expected.outcome, `outcome is ${expected.outcome}`);
  assertEqual(account.amount, AMOUNT, 'task still records its amount');
}

async function loop1(context: Context): Promise<void> {
  console.log('\n=== LOOP 1: create_and_fund -> accept -> submit -> attest -> approve ===');
  const before = await balances(context, null, PROGRESS);
  printBalances('before', PROGRESS, before);
  const task = await openTask(context, 600n, 'submitted');
  const attested = await attest(context, task);
  await send(
    connection,
    'approve_task',
    [
      approveTask(context.config, {
        ...settlementParties(context, task),
        evidenceHash: attested.evidenceHash,
      }),
    ],
    [client],
    SETTLEMENT,
  );
  await assertOutcome(context, task, before, {
    state: 'SETTLED',
    outcome: 'APPROVED',
    paid: 'developer',
  });
}

async function loop2(context: Context): Promise<void> {
  console.log('\n=== LOOP 2: ... -> attest -> wait for the review window -> expire_review ===');
  const before = await balances(context, null, PROGRESS);
  printBalances('before', PROGRESS, before);
  const task = await openTask(context, 600n, 'submitted');
  const attested = await attest(context, task);
  const timeline = computeTimeline(attested, context.platform);
  if (timeline.reviewDeadline === null) throw new Error('no review deadline');

  await expectRejection(
    connection,
    'expire_review before the review deadline',
    [expireReview(context.config, settlementParties(context, task))],
    [cranker],
  );
  await waitUntilAfter(timeline.reviewDeadline, 'the review deadline');
  await send(
    connection,
    'expire_review (permissionless, sent by an unrelated wallet)',
    [expireReview(context.config, settlementParties(context, task))],
    [cranker],
    SETTLEMENT,
  );
  await assertOutcome(context, task, before, {
    state: 'SETTLED',
    outcome: 'REVIEW_EXPIRED',
    paid: 'developer',
  });
}

async function loop3(context: Context): Promise<void> {
  console.log('\n=== LOOP 3: create_and_fund -> cancel_task ===');
  const before = await balances(context, null, PROGRESS);
  printBalances('before', PROGRESS, before);
  const task = await openTask(context, 600n, 'created');
  printBalances('while funded', PROGRESS, await balances(context, task, PROGRESS));
  await send(
    connection,
    'cancel_task',
    [cancelTask(context.config, { client: client.publicKey, task })],
    [client],
    SETTLEMENT,
  );
  await assertOutcome(context, task, before, {
    state: 'CANCELLED',
    outcome: 'CANCELLED',
    paid: 'client',
  });
}

/** The permissionless fallback, with the branch the task's own state implies. */
async function runFallback(context: Context, task: PublicKey): Promise<void> {
  const disputed = await readTask(context, task, PROGRESS);
  assertEqual(disputed.state, 'DISPUTED', 'task is DISPUTED');
  const attested = hasValidAttestation(disputed);
  console.log(`      valid attestation for the current submission: ${String(attested)}`);

  const expected = attested
    ? ({
        outcome: 'PAY_DEVELOPER',
        developer: developer.publicKey,
        treasury: context.platform.treasury,
      } as const)
    : ({ outcome: 'REFUND_CLIENT' } as const);
  const instruction = expireDispute(context.config, {
    task,
    client: client.publicKey,
    expected,
  });

  await expectRejection(
    connection,
    'expire_dispute before the dispute deadline',
    [instruction],
    [cranker],
  );
  await waitUntilAfter(disputed.disputeDeadline, 'the dispute deadline');
  await send(
    connection,
    'expire_dispute (permissionless, sent by an unrelated wallet)',
    [instruction],
    [cranker],
    SETTLEMENT,
  );
}

async function loop4a(context: Context): Promise<void> {
  console.log('\n=== LOOP 4a: ... -> attest -> reject_task -> DISPUTED -> fallback (attested) ===');
  const before = await balances(context, null, PROGRESS);
  printBalances('before', PROGRESS, before);
  const task = await openTask(context, 600n, 'submitted');
  await attest(context, task);
  await send(
    connection,
    'reject_task',
    [
      rejectTask(context.config, {
        client: client.publicKey,
        task,
        reasonHash: termsHash({
          repo: REPO,
          acceptanceCriteria: 'rejection reason: does not meet the criteria',
          workDuration: 1n,
          amount: 1n,
        }),
      }),
    ],
    [client],
    PROGRESS,
  );
  await runFallback(context, task);
  await assertOutcome(context, task, before, {
    state: 'SETTLED',
    outcome: 'DISPUTE_EXPIRED_FOR_DEVELOPER',
    paid: 'developer',
  });
}

async function loop4b(context: Context): Promise<void> {
  console.log(
    '\n=== LOOP 4b: ... -> submit (never attested) -> DISPUTED -> fallback (unattested) ===',
  );
  const before = await balances(context, null, PROGRESS);
  printBalances('before', PROGRESS, before);
  const task = await openTask(context, 8n, 'submitted');

  // Without an attestation the task is not under review, so the client cannot
  // reject it; the dispute is opened by the developer once their window opens.
  const refused = await expectRejection(
    connection,
    'reject_task on a submission that was never attested',
    [
      rejectTask(context.config, {
        client: client.publicKey,
        task,
        reasonHash: new Uint8Array(32).fill(1),
      }),
    ],
    [client],
  );
  assertEqual(refused, 'InvalidState', 'reject_task needs an attested submission');

  const submitted = await readTask(context, task, PROGRESS);
  const window = computeTimeline(submitted, context.platform).developerDisputeWindow;
  if (window === null) throw new Error('no developer dispute window');
  await waitUntilAfter(window.opensAfter, 'the start of the developer dispute window');
  await send(
    connection,
    'open_developer_dispute',
    [openDeveloperDispute(context.config, { developer: developer.publicKey, task })],
    [developer],
    PROGRESS,
  );
  await runFallback(context, task);
  await assertOutcome(context, task, before, {
    state: 'REFUNDED',
    outcome: 'DISPUTE_EXPIRED_FOR_CLIENT',
    paid: 'client',
  });
}

async function setup(): Promise<Context> {
  console.log('=== SETUP ===');
  console.log(`  rpc                ${rpcUrl}`);
  console.log(`  commitments        progress=${PROGRESS}, settlement=${SETTLEMENT}`);
  for (const wallet of [
    upgradeAuthority,
    authority,
    attester,
    mintAuthority,
    client,
    developer,
    cranker,
  ]) {
    await airdrop(connection, wallet.publicKey, 10);
  }

  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    6,
    undefined,
    {
      commitment: 'confirmed',
    },
  );
  const config = createTaskraConfig({ cluster: 'localnet', usdcMint: mint });
  console.log(`  program            ${config.programId.toBase58()}`);
  console.log(`  test mint (6 dp)   ${mint.toBase58()}`);

  await send(
    connection,
    'create token accounts for the treasury, client and developer',
    [treasuryOwner, client, developer].map((owner) =>
      createUsdcAccountIdempotent(config, { payer: cranker.publicKey, owner: owner.publicKey }),
    ),
    [cranker],
    PROGRESS,
  );
  const treasury = findAssociatedTokenAddress(treasuryOwner.publicKey, mint);
  await mintTo(
    connection,
    mintAuthority,
    mint,
    findAssociatedTokenAddress(client.publicKey, mint),
    mintAuthority,
    5n * AMOUNT,
    [],
    { commitment: 'confirmed' },
  );

  // Initialize through the same CLI the devnet deploy script uses.
  execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./initialize-platform.ts', import.meta.url))],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        RPC_URL: rpcUrl,
        TASKRA_CLUSTER: 'localnet',
        USDC_MINT: mint.toBase58(),
        TASKRA_UPGRADE_AUTHORITY_KEYPAIR: upgradeAuthorityPath,
        TASKRA_PLATFORM_AUTHORITY: authority.publicKey.toBase58(),
        TASKRA_ATTESTER: attester.publicKey.toBase58(),
        TASKRA_TREASURY_TOKEN_ACCOUNT: treasury.toBase58(),
        TASKRA_FEE_BPS: String(TEST_PROFILE.feeBps),
        TASKRA_REVIEW_WINDOW: String(TEST_PROFILE.reviewWindow),
        TASKRA_VERIFICATION_GRACE: String(TEST_PROFILE.verificationGrace),
        TASKRA_DISPUTE_TIMEOUT: String(TEST_PROFILE.disputeTimeout),
      },
    },
  );

  const platform = await fetchPlatform(connection, config, SETTLEMENT);
  assertEqual(platform.attester.toBase58(), attester.publicKey.toBase58(), 'platform attester');
  assertEqual(platform.treasury.toBase58(), treasury.toBase58(), 'platform treasury');
  assertEqual(platform.reviewWindow, TEST_PROFILE.reviewWindow, 'review window');
  return { config, platform };
}

const context = await setup();
await loop1(context);
await loop2(context);
await loop3(context);
await loop4a(context);
await loop4b(context);
console.log('\nALL VALIDATOR LOOPS PASSED');
