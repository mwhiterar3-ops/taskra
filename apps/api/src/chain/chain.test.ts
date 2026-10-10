import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  approveTask,
  cancelTask,
  createTaskraConfig,
  expireDispute,
  findAssociatedTokenAddress,
  recordAttestation,
  submitWork,
  TaskraSdkError,
  TOKEN_PROGRAM_ID,
} from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { openAccount, tokenCloseAccount, tokenTransferChecked } from '../testing/harness.js';
import { observedAmounts } from '../tasks/reconcile.js';
import {
  findTaskInstruction,
  outcomeInvokedByAnotherProgram,
  taskInstructions,
  hashArgument,
  escrowMovements,
  type InnerInstruction,
  type ObservedTransaction,
  SettlementEvidenceError,
  TransactionMismatchError,
} from './parse.js';
import { ChainUnavailableError, withRetry } from './reader.js';

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const config = createTaskraConfig({ cluster: 'localnet', usdcMint: key(7) });
const PROGRAM = config.programId.toBase58();
const task = key(20);
const client = key(21);
const developer = key(22);
const treasury = key(23);
const HASH = new Uint8Array(32).fill(0x5a);

function observed(
  instructions: readonly TransactionInstruction[],
  inner: readonly InnerInstruction[] | null = [],
): ObservedTransaction {
  return {
    signature: 'sig',
    slot: 1,
    blockTime: null,
    error: null,
    instructions: instructions.map((instruction, index) => ({
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => meta.pubkey.toBase58()),
      data: Uint8Array.from(instruction.data),
      // The inner instructions belong to the first top-level instruction.
      inner: inner === null ? null : index === 0 ? inner : [],
    })),
  };
}

/** What a report of a signature describes for the fixture task. */
const findTaskraInstruction = (transaction: ObservedTransaction, programId: string) =>
  findTaskInstruction(transaction, programId, task.toBase58());

describe('findTaskInstruction', () => {
  it('names the instruction and its accounts from the IDL', () => {
    const instruction = findTaskraInstruction(
      observed([submitWork(config, { developer, task, evidenceHash: HASH })]),
      PROGRAM,
    );
    expect(instruction.name).toBe('submit_work');
    expect(instruction.accounts['developer']).toBe(developer.toBase58());
    expect(instruction.accounts['task']).toBe(task.toBase58());
    expect(hashArgument(instruction)).toEqual(HASH);
  });

  it('reports an omitted optional account as null', () => {
    const refund = findTaskraInstruction(
      observed([expireDispute(config, { task, client, expected: { outcome: 'REFUND_CLIENT' } })]),
      PROGRAM,
    );
    expect(refund.accounts['treasury']).toBeNull();
    expect(refund.accounts['developer_token']).toBeNull();
    expect(refund.accounts['client_token']).toBe(
      findAssociatedTokenAddress(client, config.usdcMint).toBase58(),
    );
  });

  it('ignores instructions of other programs around the Taskra one', () => {
    const other = submitWork(config, { developer, task, evidenceHash: HASH });
    other.programId = key(99);
    const instruction = findTaskraInstruction(
      observed([
        other,
        recordAttestation(config, {
          attester: key(30),
          task,
          evidenceHash: HASH,
          submissionNonce: 1n,
        }),
      ]),
      PROGRAM,
    );
    expect(instruction.name).toBe('record_attestation');
  });

  it('refuses a transaction with no, several or unknown Taskra instructions', () => {
    const submit = submitWork(config, { developer, task, evidenceHash: HASH });
    expect(() => findTaskraInstruction(observed([]), PROGRAM)).toThrow(TransactionMismatchError);
    expect(() => findTaskraInstruction(observed([submit, submit]), PROGRAM)).toThrow(
      /more than one Taskra instruction for this task/,
    );

    const unknown = observed([submit]);
    const [first] = unknown.instructions;
    if (first === undefined) throw new Error('fixture has no instruction');
    const garbled = {
      ...unknown,
      instructions: [{ ...first, data: new Uint8Array(40).fill(1) }],
    };
    expect(() => findTaskraInstruction(garbled, PROGRAM)).toThrow(/unknown Taskra instruction/);

    const truncated = {
      ...unknown,
      instructions: [{ ...first, accounts: [developer.toBase58()] }],
    };
    expect(() => findTaskraInstruction(truncated, PROGRAM)).toThrow(/missing accounts/);
  });

  it('only reads a hash argument from instructions that carry exactly one', () => {
    const attest = findTaskraInstruction(
      observed([
        recordAttestation(config, {
          attester: key(30),
          task,
          evidenceHash: HASH,
          submissionNonce: 1n,
        }),
      ]),
      PROGRAM,
    );
    expect(() => hashArgument(attest)).toThrow(TransactionMismatchError);
  });
});

describe('escrowMovements and observedAmounts', () => {
  const escrow = key(40).toBase58();
  const mint = config.usdcMint.toBase58();
  const developerToken = findAssociatedTokenAddress(developer, config.usdcMint).toBase58();
  const addresses = {
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    escrow,
    task: task.toBase58(),
    mint,
  };
  const approve = approveTask(config, { task, client, developer, treasury, evidenceHash: HASH });
  const account = {
    ...openAccount({
      id: '123e4567-e89b-12d3-a456-426614174000',
      taskAddress: task.toBase58(),
      termsHash: '00'.repeat(32),
      amount: '100000000',
      workDuration: '60',
      state: 'OPEN',
      clientWallet: client.toBase58(),
    }),
    state: 'SETTLED' as const,
  };
  const pay = (to: string, amount: bigint) =>
    tokenTransferChecked(escrow, mint, to, task.toBase58(), amount);
  const close = tokenCloseAccount(escrow, client.toBase58(), task.toBase58());
  const amounts = (
    instructions: readonly TransactionInstruction[],
    inner: InnerInstruction[] | null,
  ) =>
    observedAmounts(
      findTaskraInstruction(observed(instructions, inner), PROGRAM),
      account,
      addresses,
    );

  it('reads the fee and the payout from the transfers the instruction itself made', () => {
    expect(
      amounts(
        [approve],
        [pay(treasury.toBase58(), 2_500_000n), pay(developerToken, 97_500_000n), close],
      ),
    ).toEqual({ fee: 2_500_000n, developer: 97_500_000n, client: 0n });
  });

  it('ignores inner calls to other programs and token calls on other accounts', () => {
    const elsewhere = tokenTransferChecked(
      key(50).toBase58(),
      mint,
      developerToken,
      key(51).toBase58(),
      999n,
    );
    const otherProgram = { ...pay(developerToken, 5n), programId: key(52).toBase58() };
    const movements = escrowMovements(
      findTaskraInstruction(
        observed([approve], [elsewhere, otherProgram, pay(developerToken, 97_500_000n), close]),
        PROGRAM,
      ),
      addresses,
    );
    expect([...movements.transfers]).toEqual([[developerToken, 97_500_000n]]);
    expect(movements.closed).toBe(true);
  });

  // N-3: the program sweeps the whole escrow balance to the developer, so
  // anything deposited into the escrow comes back out with the principal.
  it('does not count tokens swept out of the escrow with the principal as earnings', () => {
    // A 100 USDC task with 1,000,000 USDC deposited into its escrow.
    const deposit = 1_000_000_000_000n;
    expect(
      amounts(
        [approve],
        [pay(treasury.toBase58(), 2_500_000n), pay(developerToken, 97_500_000n + deposit), close],
      ),
    ).toEqual({ fee: 2_500_000n, developer: 97_500_000n, client: 0n });
  });

  it('records the split of the task amount at every fee rate, deposit or not', () => {
    for (const [feeBps, fee] of [
      [0, 0n],
      [1, 10_000n],
      [250, 2_500_000n],
      [10_000, 100_000_000n],
    ] as const) {
      for (const deposit of [0n, 5n]) {
        const inner = [
          // The program makes no transfer for a zero fee.
          ...(fee > 0n ? [pay(treasury.toBase58(), fee)] : []),
          pay(developerToken, 100_000_000n - fee + deposit),
          close,
        ];
        expect(
          observedAmounts(
            findTaskraInstruction(observed([approve], inner), PROGRAM),
            { ...account, feeBps },
            addresses,
          ),
        ).toEqual({ fee, developer: 100_000_000n - fee, client: 0n });
      }
    }
  });

  it('records a refund as the task amount, and only when the client was the one paid', () => {
    const cancel = cancelTask(config, { client, task });
    const clientToken = findAssociatedTokenAddress(client, config.usdcMint).toBase58();
    const cancelled = { ...account, state: 'CANCELLED' as const };
    const refund = (inner: InnerInstruction[]) =>
      observedAmounts(
        findTaskraInstruction(observed([cancel], inner), PROGRAM),
        cancelled,
        addresses,
      );
    expect(refund([pay(clientToken, 100_000_009n), close])).toEqual({
      fee: 0n,
      developer: 0n,
      client: 100_000_000n,
    });
    expect(() => refund([pay(clientToken, 99_999_999n), close])).toThrow(SettlementEvidenceError);
    expect(() => refund([pay(developerToken, 100_000_000n), close])).toThrow(
      SettlementEvidenceError,
    );
  });

  it('splits one account that is both treasury and payout as the program does', () => {
    const same = approveTask(config, {
      task,
      client,
      developer,
      treasury: new PublicKey(developerToken),
      evidenceHash: HASH,
    });
    expect(
      amounts([same], [pay(developerToken, 2_500_000n), pay(developerToken, 97_500_000n), close]),
    ).toEqual({
      fee: 2_500_000n,
      developer: 97_500_000n,
      client: 0n,
    });
  });

  it.each<[string, InnerInstruction[] | null]>([
    ['inner instructions were not reported', null],
    ['the fee is missing', [pay(developerToken, 100_000_000n), close]],
    ['the payout is short', [pay(treasury.toBase58(), 2_500_000n), pay(developerToken, 1n), close]],
    [
      'the treasury received more than the fee',
      [pay(treasury.toBase58(), 2_500_001n), pay(developerToken, 97_500_000n), close],
    ],
    [
      'the client was paid on a task that paid the developer',
      [
        pay(treasury.toBase58(), 2_500_000n),
        pay(developerToken, 97_500_000n),
        pay(findAssociatedTokenAddress(client, config.usdcMint).toBase58(), 1n),
        close,
      ],
    ],
    [
      'an unnamed account was paid',
      [
        pay(treasury.toBase58(), 2_500_000n),
        pay(developerToken, 97_500_000n),
        pay(key(60).toBase58(), 1n),
        close,
      ],
    ],
    [
      'the escrow was not closed',
      [pay(treasury.toBase58(), 2_500_000n), pay(developerToken, 97_500_000n)],
    ],
    [
      'a plain Transfer left the escrow',
      [{ ...pay(developerToken, 1n), data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) }, close],
    ],
    [
      'the amount encoding is malformed',
      [{ ...pay(developerToken, 1n), data: Uint8Array.of(12, 1) }, close],
    ],
  ])('refuses to derive amounts when %s', (_, inner) => {
    expect(() => amounts([approve], inner)).toThrow(SettlementEvidenceError);
  });
});

describe('withRetry', () => {
  const policy = { timeoutMs: 50, retryDelaysMs: [1, 1] };

  it('retries a failing read and returns the first success', async () => {
    let calls = 0;
    const value = await withRetry('getSlot', policy, () => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error('fetch failed')) : Promise.resolve(42);
    });
    expect(value).toBe(42);
    expect(calls).toBe(3);
  });

  it('gives up with ChainUnavailableError, keeping the cause out of the message', async () => {
    let calls = 0;
    const failure = withRetry('getTransaction', policy, () => {
      calls += 1;
      return Promise.reject(new Error('connect ECONNREFUSED http://secret-rpc.example/key'));
    });
    await expect(failure).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(failure).rejects.toThrow('Solana RPC getTransaction failed');
    expect(calls).toBe(3);
  });

  it('does not retry or disguise an SDK decoding error', async () => {
    let calls = 0;
    const failure = withRetry('getAccountInfo', policy, () => {
      calls += 1;
      return Promise.reject(new TaskraSdkError('INVALID_ACCOUNT_DATA', 'not a Task account'));
    });
    await expect(failure).rejects.toBeInstanceOf(TaskraSdkError);
    expect(calls).toBe(1);
  });
});

// N-1 of the second review: whoever sends a transaction decides how many
// Taskra instructions it carries, and for which tasks.
describe('transactions that call the program more than once', () => {
  const otherTask = key(30);
  const submitOther = submitWork(config, { developer, task: otherTask, evidenceHash: HASH });
  const approve = approveTask(config, { task, client, developer, treasury, evidenceHash: HASH });

  it('finds the instruction for a task next to instructions for other tasks', () => {
    const transaction = observed([submitOther, approve]);
    expect(findTaskInstruction(transaction, PROGRAM, task.toBase58()).name).toBe('approve_task');
    expect(
      taskInstructions(transaction, PROGRAM, otherTask.toBase58()).map((found) => found.name),
    ).toEqual(['submit_work']);
  });

  it('keeps each instruction with the inner instructions it made itself', () => {
    const base = observed([submitOther, approve]);
    const marker: InnerInstruction = {
      programId: key(61).toBase58(),
      accounts: [],
      data: Uint8Array.of(7),
    };
    const transaction = {
      ...base,
      instructions: base.instructions.map((instruction, index) => ({
        ...instruction,
        inner: index === 1 ? [marker] : [],
      })),
    };
    expect(findTaskInstruction(transaction, PROGRAM, task.toBase58()).inner).toEqual([marker]);
    expect(findTaskInstruction(transaction, PROGRAM, otherTask.toBase58()).inner).toEqual([]);
  });

  it('says so when every Taskra instruction is for another task', () => {
    expect(() => findTaskInstruction(observed([submitOther]), PROGRAM, task.toBase58())).toThrow(
      /different task/,
    );
    expect(taskInstructions(observed([submitOther]), PROGRAM, task.toBase58())).toEqual([]);
  });

  it('is not hidden by a Taskra instruction that cannot be decoded', () => {
    const base = observed([approve, submitOther]);
    const transaction = {
      ...base,
      instructions: base.instructions.map((instruction, index) =>
        index === 1 ? { ...instruction, data: new Uint8Array(40).fill(1) } : instruction,
      ),
    };
    expect(findTaskInstruction(transaction, PROGRAM, task.toBase58()).name).toBe('approve_task');
  });
});

describe('outcomeInvokedByAnotherProgram', () => {
  const approve = approveTask(config, { task, client, developer, treasury, evidenceHash: HASH });
  const submit = submitWork(config, { developer, task, evidenceHash: HASH });
  const asInner = (instruction: TransactionInstruction): InnerInstruction => ({
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((meta) => meta.pubkey.toBase58()),
    data: Uint8Array.from(instruction.data),
  });
  const wrapper = new TransactionInstruction({
    programId: key(70),
    keys: approve.keys,
    data: Buffer.from([1]),
  });

  it('recognises an outcome instruction for the task that another program invoked', () => {
    expect(
      outcomeInvokedByAnotherProgram(
        observed([wrapper], [asInner(approve)]),
        PROGRAM,
        task.toBase58(),
      ),
    ).toBe(true);
  });

  it('is false for a top-level call, another task, another instruction, or unreported inner instructions', () => {
    const wrapped = observed([wrapper], [asInner(approve)]);
    expect(outcomeInvokedByAnotherProgram(observed([approve]), PROGRAM, task.toBase58())).toBe(
      false,
    );
    expect(outcomeInvokedByAnotherProgram(wrapped, PROGRAM, key(30).toBase58())).toBe(false);
    expect(
      outcomeInvokedByAnotherProgram(
        observed([wrapper], [asInner(submit)]),
        PROGRAM,
        task.toBase58(),
      ),
    ).toBe(false);
    expect(
      outcomeInvokedByAnotherProgram(observed([wrapper], null), PROGRAM, task.toBase58()),
    ).toBe(false);
  });
});
