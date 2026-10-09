import { PublicKey } from '@solana/web3.js';
import {
  acceptTask,
  approveTask,
  cancelTask,
  createAndFundTask,
  evidenceHash,
  findAssociatedTokenAddress,
  findTaskAddress,
  rejectionReasonHash,
  rejectTask,
  submitWork,
  type TaskAccount,
  taskIdFromUuid,
} from '@taskra/sdk';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenBalanceChange } from '../chain/parse.js';
import {
  createDraft,
  createHarness,
  createWallet,
  DRAFT,
  escrowOf,
  type Harness,
  openAccount,
  randomSignature,
  type TaskJson,
  type TestWallet,
  TREASURY,
} from '../testing/harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const AMOUNT = 100_000_000n;
const FEE = 2_500_000n;

interface Detail {
  id: string;
  state: string;
  developerWallet: string | null;
  termsVerified: boolean | null;
  chainSource: string;
  observed: { commitment: string } | null;
  chain: { state: string; termsVerified: boolean; hasValidAttestation: boolean } | null;
  transactions: { signature: string; instruction: string; status: string; error: string | null }[];
  settlement: {
    signature: string;
    state: string;
    outcome: string;
    feeAmount: string;
    developerAmount: string;
    clientAmount: string;
  } | null;
  rejection: { reason: string } | null;
  verification: { submissionNonce: string; prNumber: string; status: string; job: unknown }[];
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function getTask(id: string, cookie?: string): Promise<Detail> {
  const response = await harness.get(`/api/v1/tasks/${id}`, cookie);
  expect(response.statusCode).toBe(200);
  return response.json<{ task: Detail }>().task;
}

function report(task: TaskJson, path: string, body: unknown, cookie: string) {
  return harness.post(`/api/v1/tasks/${task.id}/${path}`, body, cookie);
}

interface Scenario {
  readonly client: TestWallet;
  readonly clientCookie: string;
  readonly developer: TestWallet;
  readonly developerCookie: string;
  readonly task: TaskJson;
  readonly address: PublicKey;
  /** The Task account currently on the fake chain. */
  account: TaskAccount;
}

type Stage = 'DRAFT' | 'OPEN' | 'ACCEPTED' | 'SUBMITTED';

/** A task advanced on the fake chain to `stage`, finalized, with the API's cache synced. */
async function scenario(stage: Stage, existingDeveloper?: TestWallet): Promise<Scenario> {
  const client = createWallet();
  const developer = existingDeveloper ?? createWallet();
  const clientCookie = await harness.signIn(client);
  const developerCookie = await harness.signIn(developer);
  const task = await createDraft(harness, clientCookie);
  const address = new PublicKey(task.taskAddress);
  let account = openAccount(task);
  if (stage !== 'DRAFT') {
    if (stage !== 'OPEN') {
      account = {
        ...account,
        state: 'ACCEPTED',
        developer: developer.publicKey,
        acceptedAt: 1_760_000_100n,
        workDeadline: 1_760_172_900n,
        verificationDeadline: 1_760_259_300n,
      };
    }
    if (stage === 'SUBMITTED') {
      account = {
        ...account,
        state: 'SUBMITTED',
        submissionNonce: 1n,
        evidenceHash: evidenceHash({ repo: DRAFT.repo, prNumber: 42n, headSha: HEAD_SHA }),
        submittedAt: 1_760_000_200n,
        disputeOpenAt: 1_760_259_300n,
        refundOpenAt: 1_760_432_100n,
      };
    }
    harness.chain.setTask(address, account, { finalized: true });
    await getTask(task.id, clientCookie);
  }
  return { client, clientCookie, developer, developerCookie, task, address, account };
}

function fundInstruction(s: Scenario) {
  return createAndFundTask(harness.taskra, {
    client: s.client.publicKey,
    taskId: taskIdFromUuid(s.task.id),
    amount: AMOUNT,
    workDuration: BigInt(s.task.workDuration),
    termsHash: s.account.termsHash,
  });
}

/** Puts an approve_task transaction and the SETTLED account on the fake chain. */
function approveOnChain(s: Scenario, options: { finalized: boolean }): string {
  const signature = randomSignature();
  const developerToken = findAssociatedTokenAddress(s.developer.publicKey, harness.taskra.usdcMint);
  const balances: TokenBalanceChange[] = [
    { account: escrowOf(harness, s.task), mint: 'mint', pre: AMOUNT, post: 0n },
    { account: developerToken.toBase58(), mint: 'mint', pre: 5n, post: 5n + AMOUNT - FEE },
    { account: TREASURY.toBase58(), mint: 'mint', pre: 1_000n, post: 1_000n + FEE },
  ];
  harness.chain.addTransaction(
    {
      signature,
      instructions: [
        approveTask(harness.taskra, {
          task: s.address,
          client: s.client.publicKey,
          developer: s.developer.publicKey,
          treasury: TREASURY,
          evidenceHash: s.account.evidenceHash,
        }),
      ],
      tokenBalances: balances,
    },
    options,
  );
  s.account = { ...s.account, state: 'SETTLED', outcome: 'APPROVED', closedAt: 1_760_000_900n };
  harness.chain.setTask(s.address, s.account, options);
  return signature;
}

async function countRows(table: string, taskId: string): Promise<number> {
  const result = await harness.admin.query(`SELECT 1 FROM ${table} WHERE task_id = $1`, [taskId]);
  return result.rowCount ?? 0;
}

describe('drafts (T0)', () => {
  it('derives the id, the Task address and the terms hash on the server', async () => {
    const client = createWallet();
    const cookie = await harness.signIn(client);
    const task = await createDraft(harness, cookie);

    expect(task.state).toBe('DRAFT');
    expect(task.clientWallet).toBe(client.address);
    // Published vector T1 (docs/13-DECISIONS.md §5.3).
    expect(task.termsHash).toBe('30847829aaee28ae7add3254b2f0bf44a262467ed115d4f87d041bd53f50c066');
    expect(task.taskAddress).toBe(
      findTaskAddress(
        harness.taskra.programId,
        client.publicKey,
        taskIdFromUuid(task.id),
      )[0].toBase58(),
    );
  });

  it('canonicalizes the repository and normalizes the acceptance criteria', async () => {
    const cookie = await harness.signIn(createWallet());
    const response = await harness.post(
      '/api/v1/tasks',
      { ...DRAFT, repo: 'Octo-Org/Parser', acceptanceCriteria: `  ${DRAFT.acceptanceCriteria}\n` },
      cookie,
    );
    const task = response.json<{
      task: { repo: string; acceptanceCriteria: string; termsHash: string };
    }>().task;
    expect(task.repo).toBe('octo-org/parser');
    expect(task.acceptanceCriteria).toBe(DRAFT.acceptanceCriteria);
    expect(task.termsHash).toBe('30847829aaee28ae7add3254b2f0bf44a262467ed115d4f87d041bd53f50c066');
  });

  it.each([
    ['a repository URL', { repo: 'https://github.com/octo-org/parser' }],
    ['a zero amount', { amount: '0' }],
    ['a fractional amount', { amount: '1.5' }],
    ['an amount above u64', { amount: '18446744073709551616' }],
    ['a numeric amount', { amount: 100 as unknown as string }],
    ['a zero duration', { workDuration: '0' }],
    ['blank acceptance criteria', { acceptanceCriteria: '   ' }],
    ['an empty title', { title: ' ' }],
  ])('rejects %s', async (_, patch) => {
    const cookie = await harness.signIn(createWallet());
    const response = await harness.post('/api/v1/tasks', { ...DRAFT, ...patch }, cookie);
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_ERROR');
  });

  it('keeps a draft private to its client', async () => {
    const s = await scenario('DRAFT');
    expect((await getTask(s.task.id, s.clientCookie)).state).toBe('DRAFT');
    expect((await harness.get(`/api/v1/tasks/${s.task.id}`, s.developerCookie)).statusCode).toBe(
      404,
    );
    expect((await harness.get(`/api/v1/tasks/${s.task.id}`)).statusCode).toBe(404);

    const list = async (cookie?: string) =>
      (await harness.get('/api/v1/tasks?limit=100', cookie))
        .json<{ tasks: { id: string }[] }>()
        .tasks.map((task) => task.id);
    expect(await list(s.clientCookie)).toContain(s.task.id);
    expect(await list(s.developerCookie)).not.toContain(s.task.id);
    expect(await list()).not.toContain(s.task.id);
  });
});

describe('reporting a transaction', () => {
  it('records a confirmed funding as pending, then as finalized', async () => {
    const s = await scenario('DRAFT');
    const signature = randomSignature();
    harness.chain.setTask(s.address, s.account, { finalized: false });
    harness.chain.addTransaction(
      { signature, instructions: [fundInstruction(s)] },
      { finalized: false },
    );

    const response = await report(s.task, 'fund', { signature }, s.clientCookie);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      transaction: { status: string; instruction: string };
      task: Detail;
    }>();
    expect(body.transaction).toMatchObject({
      status: 'CONFIRMED',
      instruction: 'create_and_fund_task',
    });
    expect(body.task.state).toBe('OPEN');
    expect(body.task.observed?.commitment).toBe('confirmed');
    expect(body.task.settlement).toBeNull();

    harness.chain.finalizeAll();
    const later = await getTask(s.task.id);
    expect(later.transactions).toEqual([
      expect.objectContaining({ signature, status: 'FINALIZED' }),
    ]);
  });

  it('is idempotent: a repeated or concurrent report creates one record', async () => {
    const s = await scenario('DRAFT');
    const signature = randomSignature();
    harness.chain.setTask(s.address, s.account, { finalized: true });
    harness.chain.addTransaction(
      { signature, instructions: [fundInstruction(s)] },
      { finalized: true },
    );

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => report(s.task, 'fund', { signature }, s.clientCookie)),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(6).fill(200));
    expect(await countRows('onchain_transactions', s.task.id)).toBe(1);
  });

  it('requires a session', async () => {
    const s = await scenario('DRAFT');
    const response = await harness.post(`/api/v1/tasks/${s.task.id}/fund`, {
      signature: randomSignature(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for a signature the cluster does not know', async () => {
    const s = await scenario('DRAFT');
    const response = await report(s.task, 'fund', { signature: randomSignature() }, s.clientCookie);
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('TRANSACTION_NOT_FOUND');
    expect(await countRows('onchain_transactions', s.task.id)).toBe(0);
  });

  it('refuses a transaction that does not call the Taskra program', async () => {
    const s = await scenario('DRAFT');
    const signature = randomSignature();
    const foreign = fundInstruction(s);
    foreign.programId = new PublicKey(new Uint8Array(32).fill(3));
    harness.chain.addTransaction({ signature, instructions: [foreign] }, { finalized: true });
    const response = await report(s.task, 'fund', { signature }, s.clientCookie);
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('TRANSACTION_MISMATCH');
  });

  it('refuses a transaction for a different task', async () => {
    const mine = await scenario('DRAFT');
    const other = await scenario('DRAFT');
    const signature = randomSignature();
    harness.chain.addTransaction(
      { signature, instructions: [fundInstruction(other)] },
      { finalized: true },
    );
    const response = await report(mine.task, 'fund', { signature }, mine.clientCookie);
    expect(response.statusCode).toBe(422);
    expect(await countRows('onchain_transactions', mine.task.id)).toBe(0);
  });

  it('refuses a transaction whose instruction is not the one the route is for', async () => {
    const s = await scenario('OPEN');
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [cancelTask(harness.taskra, { client: s.client.publicKey, task: s.address })],
      },
      { finalized: true },
    );
    const response = await report(s.task, 'accept', { signature }, s.developerCookie);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('cancel_task');
  });

  it('refuses a transaction that calls the program twice', async () => {
    const s = await scenario('DRAFT');
    const signature = randomSignature();
    harness.chain.addTransaction(
      { signature, instructions: [fundInstruction(s), fundInstruction(s)] },
      { finalized: true },
    );
    expect((await report(s.task, 'fund', { signature }, s.clientCookie)).statusCode).toBe(422);
  });

  it('records a failed transaction as failed, with the decoded program error', async () => {
    const s = await scenario('OPEN');
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [
          acceptTask(harness.taskra, { developer: s.client.publicKey, task: s.address }),
        ],
        error: { InstructionError: [0, { Custom: 6010 }] },
      },
      { finalized: true },
    );
    const response = await report(s.task, 'accept', { signature }, s.clientCookie);
    const body = response.json<{ transaction: { status: string; error: string }; task: Detail }>();
    expect(body.transaction).toMatchObject({ status: 'FAILED', error: 'ClientCannotAccept' });
    expect(body.task.state).toBe('OPEN');
  });

  it('marks a confirmed observation dropped when a fork discards it', async () => {
    const s = await scenario('DRAFT');
    const signature = randomSignature();
    harness.chain.setTask(s.address, s.account, { finalized: false });
    harness.chain.addTransaction(
      { signature, instructions: [fundInstruction(s)] },
      { finalized: false },
    );
    await report(s.task, 'fund', { signature }, s.clientCookie);
    expect((await getTask(s.task.id, s.clientCookie)).state).toBe('OPEN');

    harness.chain.dropTransaction(signature);
    harness.chain.rollBackTask(s.address);
    harness.advance(200);
    const after = await getTask(s.task.id, s.clientCookie);
    expect(after.state).toBe('DRAFT');
    expect(after.transactions[0]).toMatchObject({ signature, status: 'DROPPED' });
    expect(await countRows('settlements', s.task.id)).toBe(0);
  });

  it('answers 503 when the RPC endpoint is down, and serves the last cache on reads', async () => {
    const s = await scenario('OPEN');
    harness.chain.available = false;
    try {
      const response = await report(
        s.task,
        'accept',
        { signature: randomSignature() },
        s.developerCookie,
      );
      expect(response.statusCode).toBe(503);
      expect(errorCode(response)).toBe('RPC_UNAVAILABLE');
      expect(response.headers['retry-after']).toBe('5');

      const cached = await getTask(s.task.id);
      expect(cached.chainSource).toBe('cache');
      expect(cached.state).toBe('OPEN');
      expect(cached.chain).toBeNull();
    } finally {
      harness.chain.available = true;
    }
    expect((await getTask(s.task.id)).chainSource).toBe('live');
  });
});

describe('settlement records', () => {
  it('records nothing financial at confirmed, and exactly one settlement at finalized', async () => {
    const s = await scenario('SUBMITTED');
    const signature = approveOnChain(s, { finalized: false });

    const confirmed = await report(s.task, 'approve', { signature }, s.clientCookie);
    const body = confirmed.json<{ transaction: { status: string }; task: Detail }>();
    expect(body.transaction.status).toBe('CONFIRMED');
    expect(body.task.state).toBe('SETTLED');
    expect(body.task.settlement).toBeNull();
    expect(await countRows('settlements', s.task.id)).toBe(0);

    harness.chain.finalizeAll();
    const final = await getTask(s.task.id);
    expect(final.settlement).toMatchObject({
      signature,
      state: 'SETTLED',
      outcome: 'APPROVED',
      feeAmount: '2500000',
      developerAmount: '97500000',
      clientAmount: '0',
    });
    expect(final.observed?.commitment).toBe('finalized');
    expect(final.transactions.at(-1)).toMatchObject({ signature, status: 'FINALIZED' });
  });

  it('never creates a second settlement under concurrent reads and duplicate reports', async () => {
    const s = await scenario('SUBMITTED');
    const signature = approveOnChain(s, { finalized: true });
    await Promise.all([
      ...Array.from({ length: 6 }, () => harness.get(`/api/v1/tasks/${s.task.id}`)),
      ...Array.from({ length: 6 }, () => report(s.task, 'approve', { signature }, s.clientCookie)),
    ]);
    expect(await countRows('settlements', s.task.id)).toBe(1);
    expect(await countRows('onchain_transactions', s.task.id)).toBe(1);
  });

  it('finds the outcome transaction itself when nobody reported it', async () => {
    const s = await scenario('SUBMITTED');
    const signature = approveOnChain(s, { finalized: true });
    const task = await getTask(s.task.id);
    expect(task.settlement?.signature).toBe(signature);
  });

  it('does not record a terminal state that is confirmed but not finalized', async () => {
    const s = await scenario('SUBMITTED');
    approveOnChain(s, { finalized: false });
    const task = await getTask(s.task.id);
    expect(task.state).toBe('SETTLED');
    expect(task.observed?.commitment).toBe('confirmed');
    expect(task.settlement).toBeNull();
  });

  it('records a cancellation as a full refund with no fee', async () => {
    const s = await scenario('OPEN');
    const signature = randomSignature();
    const clientToken = findAssociatedTokenAddress(s.client.publicKey, harness.taskra.usdcMint);
    harness.chain.addTransaction(
      {
        signature,
        instructions: [cancelTask(harness.taskra, { client: s.client.publicKey, task: s.address })],
        tokenBalances: [
          { account: escrowOf(harness, s.task), mint: 'mint', pre: AMOUNT, post: 0n },
          { account: clientToken.toBase58(), mint: 'mint', pre: 0n, post: AMOUNT },
        ],
      },
      { finalized: true },
    );
    harness.chain.setTask(
      s.address,
      { ...s.account, state: 'CANCELLED', outcome: 'CANCELLED', closedAt: 1_760_000_500n },
      { finalized: true },
    );
    const response = await report(s.task, 'transactions', { signature }, s.clientCookie);
    expect(response.json<{ task: Detail }>().task.settlement).toMatchObject({
      state: 'CANCELLED',
      feeAmount: '0',
      developerAmount: '0',
      clientAmount: AMOUNT.toString(),
    });
  });

  it('records nothing when the token movements do not add up to the escrow', async () => {
    const s = await scenario('SUBMITTED');
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [
          approveTask(harness.taskra, {
            task: s.address,
            client: s.client.publicKey,
            developer: s.developer.publicKey,
            treasury: TREASURY,
            evidenceHash: s.account.evidenceHash,
          }),
        ],
        tokenBalances: [
          { account: escrowOf(harness, s.task), mint: 'mint', pre: AMOUNT, post: 0n },
          { account: TREASURY.toBase58(), mint: 'mint', pre: 0n, post: FEE },
        ],
      },
      { finalized: true },
    );
    harness.chain.setTask(
      s.address,
      { ...s.account, state: 'SETTLED', outcome: 'APPROVED', closedAt: 1_760_000_900n },
      { finalized: true },
    );
    const task = await getTask(s.task.id);
    expect(task.state).toBe('SETTLED');
    expect(task.settlement).toBeNull();
    expect(await countRows('settlements', s.task.id)).toBe(0);
  });
});

describe('metadata that no longer matches the chain', () => {
  it('is flagged as unverified', async () => {
    const s = await scenario('DRAFT');
    harness.chain.setTask(
      s.address,
      { ...s.account, termsHash: new Uint8Array(32).fill(0xab) },
      { finalized: true },
    );
    const task = await getTask(s.task.id);
    expect(task.termsVerified).toBe(false);
    expect(task.chain?.termsVerified).toBe(false);
  });

  it('is flagged when stored metadata was edited but its stored hash was left alone', async () => {
    const s = await scenario('OPEN');
    expect((await getTask(s.task.id)).termsVerified).toBe(true);
    await harness.admin.query(`UPDATE tasks SET repo = 'attacker/repo' WHERE id = $1`, [s.task.id]);
    const task = await getTask(s.task.id);
    expect(task.termsVerified).toBe(false);
    expect(task.chain?.termsVerified).toBe(false);
  });

  it('is flagged when the on-chain amount differs from the draft', async () => {
    const s = await scenario('DRAFT');
    harness.chain.setTask(s.address, { ...s.account, amount: 1n }, { finalized: true });
    expect((await getTask(s.task.id)).termsVerified).toBe(false);
  });
});

describe('evidence', () => {
  function submitSignature(s: Scenario, hash = s.account.evidenceHash): Promise<string> {
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [
          submitWork(harness.taskra, {
            developer: s.developer.publicKey,
            task: s.address,
            evidenceHash: hash,
          }),
        ],
      },
      { finalized: true },
    );
    return Promise.resolve(signature);
  }

  it('registers the pull request for the current submission and queues one job', async () => {
    const s = await scenario('SUBMITTED');
    const body = { prNumber: 42, signature: await submitSignature(s) };
    const first = await report(s.task, 'evidence', body, s.developerCookie);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ task: Detail }>().task.verification).toEqual([
      expect.objectContaining({
        submissionNonce: '1',
        prNumber: '42',
        status: 'PENDING',
        job: { status: 'QUEUED', attempts: 0 },
      }),
    ]);

    // Repeating the request changes nothing.
    await report(s.task, 'evidence', body, s.developerCookie);
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    expect(await countRows('submissions', s.task.id)).toBe(1);
    const jobs = await harness.admin.query('SELECT 1 FROM verification_jobs');
    expect(jobs.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('accepts evidence only from the on-chain developer', async () => {
    const s = await scenario('SUBMITTED');
    const response = await report(s.task, 'evidence', { prNumber: 42 }, s.clientCookie);
    expect(response.statusCode).toBe(403);
    expect(await countRows('submissions', s.task.id)).toBe(0);
  });

  it('refuses evidence before anything is submitted on-chain', async () => {
    const s = await scenario('ACCEPTED');
    const response = await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('NO_SUBMISSION');
  });

  it('refuses a submit_work transaction that is no longer the current submission', async () => {
    const s = await scenario('SUBMITTED');
    const stale = await submitSignature(s, new Uint8Array(32).fill(0x11));
    const response = await report(
      s.task,
      'evidence',
      { prNumber: 42, signature: stale },
      s.developerCookie,
    );
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('STALE_SUBMISSION');
  });

  it('cannot re-point a registered submission at another pull request', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    const response = await report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('EVIDENCE_ALREADY_REGISTERED');
  });

  it('re-queues a finished job that produced no attestation, and registers a resubmission separately', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    await harness.admin.query(`UPDATE verification_jobs SET status = 'DONE', attempts = 3`);
    const again = await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    expect(again.json<{ task: Detail }>().task.verification[0]?.job).toEqual({
      status: 'QUEUED',
      attempts: 0,
    });

    s.account = {
      ...s.account,
      submissionNonce: 2n,
      evidenceHash: evidenceHash({ repo: DRAFT.repo, prNumber: 43n, headSha: HEAD_SHA }),
    };
    harness.chain.setTask(s.address, s.account, { finalized: true });
    const resubmitted = await report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
    expect(
      resubmitted.json<{ task: Detail }>().task.verification.map((entry) => entry.submissionNonce),
    ).toEqual(['2', '1']);
  });
});

describe('rejection reason', () => {
  const REASON = 'The parser does not return structured output.';

  function rejectOnChain(s: Scenario, reason: string): Promise<string> {
    const signature = randomSignature();
    const reasonHash = rejectionReasonHash(reason);
    harness.chain.addTransaction(
      {
        signature,
        instructions: [
          rejectTask(harness.taskra, { client: s.client.publicKey, task: s.address, reasonHash }),
        ],
      },
      { finalized: true },
    );
    s.account = {
      ...s.account,
      state: 'DISPUTED',
      disputedAt: 1_760_000_700n,
      disputeDeadline: 1_760_605_500n,
      rejectionReasonHash: reasonHash,
    };
    harness.chain.setTask(s.address, s.account, { finalized: true });
    return Promise.resolve(signature);
  }

  it('stores the text only when it hashes to what the transaction recorded', async () => {
    const s = await scenario('SUBMITTED');
    const signature = await rejectOnChain(s, REASON);

    const wrong = await report(
      s.task,
      'reject',
      { signature, reason: 'something else' },
      s.clientCookie,
    );
    expect(wrong.statusCode).toBe(422);
    expect(errorCode(wrong)).toBe('REASON_MISMATCH');
    expect(await countRows('rejection_reasons', s.task.id)).toBe(0);

    const right = await report(
      s.task,
      'reject',
      { signature, reason: `  ${REASON}\n` },
      s.clientCookie,
    );
    expect(right.statusCode).toBe(200);
    const task = right.json<{ task: Detail }>().task;
    expect(task.state).toBe('DISPUTED');
    expect(task.rejection).toMatchObject({ reason: REASON });
  });

  it('accepts a reason only from the client', async () => {
    const s = await scenario('SUBMITTED');
    const signature = await rejectOnChain(s, REASON);
    const response = await report(
      s.task,
      'reject',
      { signature, reason: REASON },
      s.developerCookie,
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('listing and reputation', () => {
  it('filters the cached list by state, client and developer', async () => {
    const s = await scenario('ACCEPTED');
    const ids = async (query: string) =>
      (await harness.get(`/api/v1/tasks?limit=100&${query}`))
        .json<{ tasks: { id: string }[] }>()
        .tasks.map((task) => task.id);
    expect(await ids(`developer=${s.developer.address}`)).toEqual([s.task.id]);
    expect(await ids(`client=${s.client.address}&state=ACCEPTED`)).toEqual([s.task.id]);
    expect(await ids(`client=${s.client.address}&state=OPEN`)).toEqual([]);
    expect((await harness.get('/api/v1/tasks?state=NOPE')).statusCode).toBe(400);
  });

  it('derives reputation from finalized settlements only', async () => {
    const developer = createWallet();
    const reputation = async () =>
      (await harness.get(`/api/v1/users/${developer.address}/reputation`)).json<{
        developer: { tasksSettled: number; distinctClients: number; totalEarned: string };
        reliableContributor: { qualified: boolean; label: string };
        verifiedWork: { taskId: string }[];
      }>();

    const pending = await scenario('SUBMITTED', developer);
    approveOnChain(pending, { finalized: false });
    await getTask(pending.task.id);
    expect((await reputation()).developer.tasksSettled).toBe(0);

    harness.chain.finalizeAll();
    await getTask(pending.task.id);
    for (let index = 0; index < 2; index += 1) {
      const s = await scenario('SUBMITTED', developer);
      approveOnChain(s, { finalized: true });
      await getTask(s.task.id);
    }

    const result = await reputation();
    expect(result.developer).toEqual({
      tasksSettled: 3,
      tasksRefunded: 0,
      tasksDisputed: 0,
      distinctClients: 3,
      totalEarned: (3n * (AMOUNT - FEE)).toString(),
    });
    expect(result.reliableContributor).toMatchObject({
      qualified: true,
      label: 'Off-chain aggregate',
    });
    expect(result.verifiedWork).toHaveLength(3);
  });

  it('reports whether a wallet has signed in', async () => {
    const known = createWallet();
    await harness.signIn(known);
    expect((await harness.get(`/api/v1/users/${known.address}`)).json()).toMatchObject({
      registered: true,
      github: null,
    });
    expect((await harness.get(`/api/v1/users/${createWallet().address}`)).json()).toMatchObject({
      registered: false,
    });
    expect((await harness.get('/api/v1/users/not-a-wallet')).statusCode).toBe(400);
  });
});
