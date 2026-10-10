import { PublicKey, TransactionInstruction } from '@solana/web3.js';
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
  TOKEN_PROGRAM_ID,
} from '@taskra/sdk';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InnerInstruction, SettlementEvidenceError } from '../chain/parse.js';
import {
  createDraft,
  createHarness,
  createWallet,
  DRAFT,
  escrowOf,
  type Harness,
  openAccount,
  randomSignature,
  settlementInner,
  type TaskJson,
  type TestWallet,
  tokenCloseAccount,
  tokenTransferChecked,
  TREASURY,
} from '../testing/harness.js';
import { reconcileTask, type TaskRow } from './reconcile.js';

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

function developerTokenOf(s: Scenario): string {
  return findAssociatedTokenAddress(s.developer.publicKey, harness.taskra.usdcMint).toBase58();
}

function approveInstruction(s: Scenario): TransactionInstruction {
  return approveTask(harness.taskra, {
    task: s.address,
    client: s.client.publicKey,
    developer: s.developer.publicKey,
    treasury: TREASURY,
    evidenceHash: s.account.evidenceHash,
  });
}

/** What the program's own token calls look like for an approval of `s`. */
function approveInner(s: Scenario): InnerInstruction[] {
  return settlementInner(harness, s.task, [
    [TREASURY.toBase58(), FEE],
    [developerTokenOf(s), AMOUNT - FEE],
  ]);
}

/** An SPL Token `Transfer` between two unrelated accounts, as a top-level instruction. */
function unrelatedTransfer(to: string, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(amount, 1);
  const from = createWallet().publicKey;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(to), isSigner: false, isWritable: true },
      { pubkey: from, isSigner: true, isWritable: false },
    ],
    data,
  });
}

interface ApproveOptions {
  readonly finalized: boolean;
  /** Further top-level instructions placed after approve_task. */
  readonly extra?: readonly TransactionInstruction[];
  /** Replaces the inner instructions of approve_task; `null` models a node that reports none. */
  readonly inner?: readonly InnerInstruction[] | null;
  /** Inner instructions of the extra instructions, by top-level index. */
  readonly extraInner?: Readonly<Record<number, readonly InnerInstruction[]>>;
}

/** Puts an approve_task transaction and the SETTLED account on the fake chain. */
function approveOnChain(s: Scenario, options: ApproveOptions): string {
  const signature = randomSignature();
  harness.chain.addTransaction(
    {
      signature,
      instructions: [approveInstruction(s), ...(options.extra ?? [])],
      ...(options.inner === null
        ? { innerMissing: true }
        : { inner: { 0: options.inner ?? approveInner(s), ...options.extraInner } }),
    },
    { finalized: options.finalized },
  );
  s.account = { ...s.account, state: 'SETTLED', outcome: 'APPROVED', closedAt: 1_760_000_900n };
  harness.chain.setTask(s.address, s.account, { finalized: options.finalized });
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
    ['a duration one second above the program maximum', { workDuration: '31536001' }],
    ['a duration near the i64 limit', { workDuration: '9223372034854775795' }],
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
        inner: { 0: settlementInner(harness, s.task, [[clientToken.toBase58(), AMOUNT]]) },
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
});

// M-02 of the security review: whoever sends a settlement can put anything else
// in the same transaction. None of it may change, or prevent, what is recorded.
describe('settlement transactions composed with other instructions', () => {
  async function reputationOf(wallet: TestWallet) {
    const response = await harness.get(`/api/v1/users/${wallet.address}/reputation`);
    return response.json<{ developer: { tasksSettled: number; totalEarned: string } }>().developer;
  }

  it('records the exact settlement when one base unit is also sent to the developer', async () => {
    const s = await scenario('SUBMITTED');
    // The attack: approve_task plus a 1-unit transfer to the developer's token account.
    const signature = approveOnChain(s, {
      finalized: true,
      extra: [unrelatedTransfer(developerTokenOf(s), 1n)],
    });

    const task = await getTask(s.task.id);
    expect(task.settlement).toMatchObject({
      signature,
      state: 'SETTLED',
      feeAmount: FEE.toString(),
      developerAmount: (AMOUNT - FEE).toString(),
      clientAmount: '0',
    });

    // Read again, and report it as well: still one record, credited once.
    await getTask(s.task.id);
    await report(s.task, 'approve', { signature }, s.clientCookie);
    expect(await countRows('settlements', s.task.id)).toBe(1);
    expect(await reputationOf(s.developer)).toEqual(
      expect.objectContaining({ tasksSettled: 1, totalEarned: (AMOUNT - FEE).toString() }),
    );
  });

  it('ignores large transfers to the treasury and the client made by other instructions', async () => {
    const s = await scenario('SUBMITTED');
    const clientToken = findAssociatedTokenAddress(s.client.publicKey, harness.taskra.usdcMint);
    approveOnChain(s, {
      finalized: true,
      extra: [
        unrelatedTransfer(TREASURY.toBase58(), 9_000_000_000n),
        unrelatedTransfer(clientToken.toBase58(), 5_000_000n),
      ],
    });
    expect((await getTask(s.task.id)).settlement).toMatchObject({
      feeAmount: FEE.toString(),
      developerAmount: (AMOUNT - FEE).toString(),
      clientAmount: '0',
    });
  });

  it('ignores escrow-shaped transfers made inside a different top-level instruction', async () => {
    const s = await scenario('SUBMITTED');
    const attacker = createWallet().address;
    // Another instruction "transfers" from this escrow to the attacker. It is not
    // the Taskra instruction's own call, so it is not evidence of anything.
    approveOnChain(s, {
      finalized: true,
      extra: [unrelatedTransfer(attacker, 1n)],
      extraInner: {
        1: [
          tokenTransferChecked(
            escrowOf(harness, s.task),
            harness.taskra.usdcMint.toBase58(),
            attacker,
            s.task.taskAddress,
            AMOUNT,
          ),
        ],
      },
    });
    expect((await getTask(s.task.id)).settlement).toMatchObject({
      developerAmount: (AMOUNT - FEE).toString(),
    });
  });

  // N-3: the program sweeps the whole escrow balance to the developer. A
  // developer who deposits 1,000,000 USDC into the escrow of a 100 USDC task
  // gets it straight back; it was never earned.
  it('does not count a deposit swept back to the developer as earnings', async () => {
    const s = await scenario('SUBMITTED');
    const deposit = 1_000_000_000_000n;
    approveOnChain(s, {
      finalized: true,
      inner: settlementInner(harness, s.task, [
        [TREASURY.toBase58(), FEE],
        [developerTokenOf(s), AMOUNT - FEE + deposit],
      ]),
    });
    expect((await getTask(s.task.id)).settlement).toMatchObject({
      amount: AMOUNT.toString(),
      feeAmount: FEE.toString(),
      developerAmount: (AMOUNT - FEE).toString(),
      clientAmount: '0',
    });
    expect(await reputationOf(s.developer)).toEqual(
      expect.objectContaining({ tasksSettled: 1, totalEarned: (AMOUNT - FEE).toString() }),
    );
    const clientSide = await harness.get(`/api/v1/users/${s.client.address}/reputation`);
    expect(clientSide.json<{ client: { totalPaid: string } }>().client.totalPaid).toBe(
      AMOUNT.toString(),
    );
  });

  it('records a refund as the task amount when a deposit is swept back with it', async () => {
    const s = await scenario('OPEN');
    const signature = randomSignature();
    const clientToken = findAssociatedTokenAddress(s.client.publicKey, harness.taskra.usdcMint);
    harness.chain.addTransaction(
      {
        signature,
        instructions: [cancelTask(harness.taskra, { client: s.client.publicKey, task: s.address })],
        inner: {
          0: settlementInner(harness, s.task, [[clientToken.toBase58(), AMOUNT + 12_345n]]),
        },
      },
      { finalized: true },
    );
    s.account = {
      ...s.account,
      state: 'CANCELLED',
      outcome: 'CANCELLED',
      closedAt: 1_760_000_900n,
    };
    harness.chain.setTask(s.address, s.account, { finalized: true });
    expect((await getTask(s.task.id)).settlement).toMatchObject({
      state: 'CANCELLED',
      feeAmount: '0',
      developerAmount: '0',
      clientAmount: AMOUNT.toString(),
    });
  });

  it('waits, recording nothing, when the RPC node reports no inner instructions', async () => {
    const s = await scenario('SUBMITTED');
    const signature = approveOnChain(s, { finalized: true, inner: null });
    expect((await getTask(s.task.id)).settlement).toBeNull();
    expect(await countRows('settlements', s.task.id)).toBe(0);

    // A node that does report them: the same transaction is now recorded.
    harness.chain.addTransaction(
      { signature, instructions: [approveInstruction(s)], inner: { 0: approveInner(s) } },
      { finalized: true },
    );
    expect((await getTask(s.task.id)).settlement?.signature).toBe(signature);
  });

  const mint = () => harness.taskra.usdcMint.toBase58();
  const malformed: readonly (readonly [string, (s: Scenario) => InnerInstruction[]])[] = [
    [
      'the fee did not reach the treasury',
      (s) => settlementInner(harness, s.task, [[developerTokenOf(s), AMOUNT]]),
    ],
    [
      'the developer received less than the principal minus the fee',
      (s) =>
        settlementInner(harness, s.task, [
          [TREASURY.toBase58(), FEE],
          [developerTokenOf(s), 1n],
        ]),
    ],
    [
      'the escrow paid an account the instruction did not name',
      (s) =>
        settlementInner(harness, s.task, [
          [TREASURY.toBase58(), FEE],
          [developerTokenOf(s), AMOUNT - FEE],
          [createWallet().address, 1n],
        ]),
    ],
    [
      'the escrow paid the client on a SETTLED task',
      (s) =>
        settlementInner(harness, s.task, [
          [
            findAssociatedTokenAddress(s.client.publicKey, harness.taskra.usdcMint).toBase58(),
            AMOUNT,
          ],
        ]),
    ],
    ['the escrow was not closed', (s) => approveInner(s).slice(0, 2)],
    [
      // Correct in every other respect, so only the authority check can refuse it.
      'the transfer was not signed by the Task PDA',
      (s) => [
        ...approveInner(s).slice(0, 1),
        tokenTransferChecked(
          escrowOf(harness, s.task),
          mint(),
          developerTokenOf(s),
          createWallet().address,
          AMOUNT - FEE,
        ),
        ...approveInner(s).slice(2),
      ],
    ],
    [
      'the escrow was not closed by the Task PDA',
      (s) => [
        ...approveInner(s).slice(0, 2),
        tokenCloseAccount(escrowOf(harness, s.task), s.task.clientWallet, createWallet().address),
      ],
    ],
    [
      'the transfer was of a different mint',
      (s) => [
        tokenTransferChecked(
          escrowOf(harness, s.task),
          createWallet().address,
          TREASURY.toBase58(),
          s.task.taskAddress,
          FEE,
        ),
        ...approveInner(s).slice(1),
      ],
    ],
    ['there were no transfers at all', () => []],
  ];

  it.each(malformed)('records no settlement when %s', async (_, inner) => {
    const s = await scenario('SUBMITTED');
    approveOnChain(s, { finalized: true, inner: inner(s) });
    const task = await getTask(s.task.id);
    // The chain state is still shown; only the financial record is withheld.
    expect(task.state).toBe('SETTLED');
    expect(task.settlement).toBeNull();
    expect(await countRows('settlements', s.task.id)).toBe(0);
    expect((await reputationOf(s.developer)).tasksSettled).toBe(0);
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

  it('lets the developer correct the pull request of an unverified submission', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
    // A run for the wrong number finished without verifying anything.
    await harness.admin.query(`UPDATE verification_jobs SET status = 'DONE', attempts = 2`);

    const corrected = await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json<{ task: Detail }>().task.verification).toEqual([
      expect.objectContaining({
        submissionNonce: '1',
        prNumber: '42',
        job: { status: 'QUEUED', attempts: 0 },
      }),
    ]);
    expect(await countRows('submissions', s.task.id)).toBe(1);
    // Still only the developer.
    expect((await report(s.task, 'evidence', { prNumber: 44 }, s.clientCookie)).statusCode).toBe(
      403,
    );
  });

  it('locks the registration once the submission is verified', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    const hash = Buffer.from(s.account.evidenceHash).toString('hex');
    await harness.admin.query(
      `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
              verifier_version, attester_pubkey, repo, pr_number, head_sha, merge_commit_sha,
              pr_author_id, pr_author_login, merged_by_id, merged_by_login, merged_at,
              repo_created_at, recomputed_evidence_hash, onchain_evidence_hash,
              onchain_submission_nonce, github_meta)
       SELECT id, 'VERIFIED', '[]', 'v', 'test', $2, 'octo-org/parser', 42, $3, $3, 1, 'dev', 2,
              'maintainer', now(), now(), $4, $4, 1, '{}'
         FROM submissions WHERE task_id = $1`,
      [s.task.id, s.developer.address, HEAD_SHA, hash],
    );

    const response = await report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('EVIDENCE_LOCKED');
    const stored = await harness.admin.query<{ pr_number: string }>(
      `SELECT pr_number FROM submissions WHERE task_id = $1`,
      [s.task.id],
    );
    expect(stored.rows).toEqual([{ pr_number: '42' }]);
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

// N-1 of the second review: whoever sends a settlement also decides how many
// Taskra instructions the transaction carries, and for which tasks. A task's
// outcome must be recorded from its own instruction whatever stands beside it.
describe('settlement transactions with several Taskra instructions', () => {
  const VERIFIED_SQL = `SELECT * FROM tasks WHERE id = $1`;

  async function reputationOf(wallet: TestWallet) {
    const response = await harness.get(`/api/v1/users/${wallet.address}/reputation`);
    return response.json<{ developer: { tasksSettled: number; totalEarned: string } }>().developer;
  }

  /** What reconciliation itself reports, including why nothing was recorded. */
  async function reconcile(s: Scenario) {
    const row = await harness.admin.query<TaskRow>(VERIFIED_SQL, [s.task.id]);
    const [task] = row.rows;
    if (task === undefined) throw new Error('task row is missing');
    return reconcileTask(harness.deps, task);
  }

  function markSettled(s: Scenario): void {
    s.account = { ...s.account, state: 'SETTLED', outcome: 'APPROVED', closedAt: 1_760_000_900n };
    harness.chain.setTask(s.address, s.account, { finalized: true });
  }

  function markCancelled(s: Scenario): void {
    s.account = {
      ...s.account,
      state: 'CANCELLED',
      outcome: 'CANCELLED',
      closedAt: 1_760_000_900n,
    };
    harness.chain.setTask(s.address, s.account, { finalized: true });
  }

  const cancelInstruction = (s: Scenario) =>
    cancelTask(harness.taskra, { client: s.client.publicKey, task: s.address });
  const cancelInner = (s: Scenario) =>
    settlementInner(harness, s.task, [
      [findAssociatedTokenAddress(s.client.publicKey, harness.taskra.usdcMint).toBase58(), AMOUNT],
    ]);

  const exactSettlement = (signature: string) => ({
    signature,
    state: 'SETTLED',
    feeAmount: FEE.toString(),
    developerAmount: (AMOUNT - FEE).toString(),
    clientAmount: '0',
  });

  it('records the settlement when the same transaction also creates another task', async () => {
    const s = await scenario('SUBMITTED');
    const other = await scenario('DRAFT');
    // The attack: approve_task, plus create_and_fund_task for an unrelated task.
    const signature = approveOnChain(s, { finalized: true, extra: [fundInstruction(other)] });

    expect((await getTask(s.task.id)).settlement).toMatchObject(exactSettlement(signature));
    // Reported as well, and read again: still one record, credited once.
    const reported = await report(s.task, 'approve', { signature }, s.clientCookie);
    expect(reported.statusCode).toBe(200);
    await getTask(s.task.id);
    expect(await countRows('settlements', s.task.id)).toBe(1);
    expect(await reputationOf(s.developer)).toEqual(
      expect.objectContaining({ tasksSettled: 1, totalEarned: (AMOUNT - FEE).toString() }),
    );
    // The other task was created by the same transaction and can report it too.
    const funded = await report(other.task, 'fund', { signature }, other.clientCookie);
    expect(funded.statusCode).toBe(200);
    expect(funded.json<{ transaction: { instruction: string } }>().transaction.instruction).toBe(
      'create_and_fund_task',
    );
  });

  it('records both tasks, once each, when one transaction settles two', async () => {
    const paid = await scenario('SUBMITTED');
    const withdrawn = await scenario('OPEN');
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [approveInstruction(paid), cancelInstruction(withdrawn)],
        inner: { 0: approveInner(paid), 1: cancelInner(withdrawn) },
      },
      { finalized: true },
    );
    markSettled(paid);
    markCancelled(withdrawn);

    // Concurrent reads and reports of the one signature, for both tasks.
    await Promise.all([
      ...Array.from({ length: 4 }, () => harness.get(`/api/v1/tasks/${paid.task.id}`)),
      ...Array.from({ length: 4 }, () => harness.get(`/api/v1/tasks/${withdrawn.task.id}`)),
      ...Array.from({ length: 3 }, () =>
        report(paid.task, 'approve', { signature }, paid.clientCookie),
      ),
      ...Array.from({ length: 3 }, () =>
        report(withdrawn.task, 'transactions', { signature }, withdrawn.clientCookie),
      ),
    ]);

    expect((await getTask(paid.task.id)).settlement).toMatchObject(exactSettlement(signature));
    expect((await getTask(withdrawn.task.id)).settlement).toMatchObject({
      signature,
      state: 'CANCELLED',
      feeAmount: '0',
      developerAmount: '0',
      clientAmount: AMOUNT.toString(),
    });
    for (const s of [paid, withdrawn]) {
      expect(await countRows('settlements', s.task.id)).toBe(1);
      expect(await countRows('onchain_transactions', s.task.id)).toBe(1);
    }
    expect((await reputationOf(paid.developer)).tasksSettled).toBe(1);
  });

  it('gives each task only the transfers its own instruction made', async () => {
    const paid = await scenario('SUBMITTED');
    const withdrawn = await scenario('OPEN');
    const signature = randomSignature();
    harness.chain.addTransaction(
      {
        signature,
        instructions: [approveInstruction(paid), cancelInstruction(withdrawn)],
        inner: {
          0: approveInner(paid),
          // Listed under the other task's instruction, so not the first task's own.
          1: [
            ...cancelInner(withdrawn),
            tokenTransferChecked(
              escrowOf(harness, paid.task),
              harness.taskra.usdcMint.toBase58(),
              createWallet().address,
              paid.task.taskAddress,
              AMOUNT,
            ),
          ],
        },
      },
      { finalized: true },
    );
    markSettled(paid);
    markCancelled(withdrawn);
    expect((await getTask(paid.task.id)).settlement).toMatchObject(exactSettlement(signature));
    expect((await getTask(withdrawn.task.id)).settlement?.clientAmount).toBe(AMOUNT.toString());
  });

  it('records nothing if a successful transaction claims two outcomes for one task', async () => {
    const s = await scenario('SUBMITTED');
    // Cannot happen on-chain: the second outcome instruction would fail.
    const signature = approveOnChain(s, {
      finalized: true,
      extra: [approveInstruction(s)],
      extraInner: { 1: approveInner(s) },
    });
    expect((await getTask(s.task.id)).settlement).toBeNull();
    expect(await countRows('settlements', s.task.id)).toBe(0);
    const { problem } = await reconcile(s);
    expect(problem).toBeInstanceOf(SettlementEvidenceError);
    expect(String(problem)).toMatch(/more than one outcome instruction/);
    const reported = await report(s.task, 'approve', { signature }, s.clientCookie);
    expect(reported.statusCode).toBe(422);
  });

  it('passes over a failed transaction carrying the outcome instruction', async () => {
    const s = await scenario('SUBMITTED');
    const good = approveOnChain(s, { finalized: true });
    // Newer, failed, and "paying" somebody else entirely.
    harness.chain.addTransaction(
      {
        signature: randomSignature(),
        instructions: [approveInstruction(s)],
        inner: { 0: settlementInner(harness, s.task, [[createWallet().address, AMOUNT]]) },
        error: { InstructionError: [0, { Custom: 6000 }] },
      },
      { finalized: true },
    );
    expect((await getTask(s.task.id)).settlement).toMatchObject(exactSettlement(good));
    expect(await countRows('settlements', s.task.id)).toBe(1);
  });

  it('waits when inner instructions are missing for a two-instruction transaction, then records both', async () => {
    const paid = await scenario('SUBMITTED');
    const withdrawn = await scenario('OPEN');
    const signature = randomSignature();
    const instructions = [approveInstruction(paid), cancelInstruction(withdrawn)];
    harness.chain.addTransaction(
      { signature, instructions, innerMissing: true },
      { finalized: true },
    );
    markSettled(paid);
    markCancelled(withdrawn);
    for (const s of [paid, withdrawn]) {
      expect((await getTask(s.task.id)).settlement).toBeNull();
      expect(await countRows('settlements', s.task.id)).toBe(0);
    }
    harness.chain.addTransaction(
      { signature, instructions, inner: { 0: approveInner(paid), 1: cancelInner(withdrawn) } },
      { finalized: true },
    );
    for (const s of [paid, withdrawn]) {
      expect((await getTask(s.task.id)).settlement?.signature).toBe(signature);
    }
  });

  // Not supported, and refused explicitly: approve_task invoked by another
  // program is not a top-level instruction (docs/13-DECISIONS.md, section 17.4).
  describe('through another program', () => {
    function wrappedApproval(s: Scenario, options: { innerMissing?: boolean } = {}): string {
      const signature = randomSignature();
      const approve = approveInstruction(s);
      const wrapper = new TransactionInstruction({
        programId: createWallet().publicKey,
        keys: approve.keys,
        data: Buffer.from([1]),
      });
      harness.chain.addTransaction(
        {
          signature,
          instructions: [wrapper],
          ...(options.innerMissing === true
            ? { innerMissing: true }
            : {
                inner: {
                  0: [
                    {
                      programId: approve.programId.toBase58(),
                      accounts: approve.keys.map((key) => key.pubkey.toBase58()),
                      data: Uint8Array.from(approve.data),
                    },
                    ...approveInner(s),
                  ],
                },
              }),
        },
        { finalized: true },
      );
      markSettled(s);
      return signature;
    }

    it('records no settlement and no reputation, and says why', async () => {
      const s = await scenario('SUBMITTED');
      const signature = wrappedApproval(s);
      const task = await getTask(s.task.id);
      // The chain state is still shown truthfully.
      expect(task.state).toBe('SETTLED');
      expect(task.settlement).toBeNull();
      expect(await countRows('settlements', s.task.id)).toBe(0);
      expect((await reputationOf(s.developer)).tasksSettled).toBe(0);

      const { problem } = await reconcile(s);
      expect(problem).toBeInstanceOf(SettlementEvidenceError);
      expect(String(problem)).toContain(signature);
      expect(String(problem)).toMatch(/through another program/);

      const reported = await report(s.task, 'approve', { signature }, s.clientCookie);
      expect(reported.statusCode).toBe(422);
      expect(errorCode(reported)).toBe('TRANSACTION_MISMATCH');
    });

    it('cannot tell without inner instructions, records nothing and says the outcome was not found', async () => {
      const s = await scenario('SUBMITTED');
      wrappedApproval(s, { innerMissing: true });
      expect((await getTask(s.task.id)).settlement).toBeNull();
      const { problem } = await reconcile(s);
      expect(problem).toBeInstanceOf(SettlementEvidenceError);
      expect(String(problem)).toMatch(/outcome transaction was not found/);
      expect(await countRows('settlements', s.task.id)).toBe(0);
    });
  });

  // L-07: discovery reads a bounded number of signatures. An outcome pushed out
  // of that window must not stay unrecorded in silence, and must be recoverable.
  describe('whose signature is not among the newest for the task', () => {
    it('reports that the outcome was not found, then records it once it is reported', async () => {
      const s = await scenario('SUBMITTED');
      const signature = approveOnChain(s, { finalized: true });
      // Anyone can do this: 25 newer transactions that merely name the Task account.
      for (let count = 0; count < 25; count += 1) {
        harness.chain.addTransaction(
          {
            signature: randomSignature(),
            instructions: [
              new TransactionInstruction({
                programId: createWallet().publicKey,
                keys: [{ pubkey: s.address, isSigner: false, isWritable: false }],
                data: Buffer.from([0]),
              }),
            ],
          },
          { finalized: true },
        );
      }

      expect((await getTask(s.task.id)).settlement).toBeNull();
      const { problem } = await reconcile(s);
      expect(problem).toBeInstanceOf(SettlementEvidenceError);
      expect(String(problem)).toMatch(/outcome transaction was not found/);
      expect((await reputationOf(s.developer)).tasksSettled).toBe(0);

      // Anyone signed in can report it; the developer has every reason to.
      const reported = await report(s.task, 'transactions', { signature }, s.developerCookie);
      expect(reported.statusCode).toBe(200);
      expect((await getTask(s.task.id)).settlement).toMatchObject(exactSettlement(signature));
      expect((await reconcile(s)).problem).toBeUndefined();
      expect(await reputationOf(s.developer)).toEqual(
        expect.objectContaining({ tasksSettled: 1, totalEarned: (AMOUNT - FEE).toString() }),
      );
    });
  });
});

// N-2 of the second review: a correction of the pull-request number and the
// attestation service's VERIFIED record must not interleave.
describe('correcting evidence while it is being verified', () => {
  async function waitingForALock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await harness.admin.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (waiting.rowCount !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no statement started waiting for a lock');
  }

  it('answers EVIDENCE_LOCKED when the VERIFIED result commits while the correction waits', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    const hash = Buffer.from(s.account.evidenceHash).toString('hex');
    const attester = await harness.admin.connect();
    let response: LightMyRequestResponse;
    try {
      // The attestation service's transaction: VERIFIED for #42, not yet committed.
      await attester.query('BEGIN');
      await attester.query(
        `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
                verifier_version, attester_pubkey, repo, pr_number, head_sha, merge_commit_sha,
                pr_author_id, pr_author_login, merged_by_id, merged_by_login, merged_at,
                repo_created_at, recomputed_evidence_hash, onchain_evidence_hash,
                onchain_submission_nonce, github_meta)
         SELECT id, 'VERIFIED', '[]', 'v', 'test', $2, 'octo-org/parser', 42, $3, $3, 1, 'dev', 2,
                'maintainer', now(), now(), $4, $4, 1, '{}'
           FROM submissions WHERE task_id = $1`,
        [s.task.id, s.developer.address, HEAD_SHA, hash],
      );
      const pending = report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
      await waitingForALock();
      await attester.query('COMMIT');
      response = await pending;
    } finally {
      attester.release();
    }
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('EVIDENCE_LOCKED');
    const stored = await harness.admin.query<{ registered: string; verified: string }>(
      `SELECT s.pr_number AS registered, r.pr_number AS verified
         FROM submissions s JOIN verification_results r ON r.submission_id = s.id
        WHERE s.task_id = $1 AND r.status = 'VERIFIED'`,
      [s.task.id],
    );
    expect(stored.rows).toEqual([{ registered: '42', verified: '42' }]);
  });

  it('does not show a result for the old number as the status of a corrected registration', async () => {
    const s = await scenario('SUBMITTED');
    await report(s.task, 'evidence', { prNumber: 43 }, s.developerCookie);
    await harness.admin.query(
      `INSERT INTO verification_results (submission_id, status, rules, ruleset_version,
              verifier_version, attester_pubkey, repo, pr_number, github_meta)
       SELECT id, 'REJECTED', '[]', 'v', 'test', $2, 'octo-org/parser', 43, '{}'
         FROM submissions WHERE task_id = $1`,
      [s.task.id, s.developer.address],
    );
    expect((await getTask(s.task.id)).verification[0]).toMatchObject({
      prNumber: '43',
      status: 'REJECTED',
    });
    await report(s.task, 'evidence', { prNumber: 42 }, s.developerCookie);
    // #42 has not been checked yet; the rejection was about #43.
    expect((await getTask(s.task.id)).verification[0]).toMatchObject({
      prNumber: '42',
      status: 'PENDING',
    });
  });
});
