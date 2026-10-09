import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  approveTask,
  createTaskraConfig,
  expireDispute,
  findAssociatedTokenAddress,
  recordAttestation,
  submitWork,
  TaskraSdkError,
} from '@taskra/sdk';
import { describe, expect, it } from 'vitest';
import { openAccount } from '../testing/harness.js';
import { observedAmounts } from '../tasks/reconcile.js';
import {
  findTaskraInstruction,
  hashArgument,
  type ObservedTransaction,
  type TokenBalanceChange,
  tokenDelta,
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
  tokenBalances: readonly TokenBalanceChange[] = [],
): ObservedTransaction {
  return {
    signature: 'sig',
    slot: 1,
    blockTime: null,
    error: null,
    instructions: instructions.map((instruction) => ({
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => meta.pubkey.toBase58()),
      data: Uint8Array.from(instruction.data),
    })),
    tokenBalances,
  };
}

describe('findTaskraInstruction', () => {
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
      /more than once/,
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

describe('observedAmounts', () => {
  const escrow = key(40).toBase58();
  const developerToken = findAssociatedTokenAddress(developer, config.usdcMint).toBase58();
  const approve = approveTask(config, { task, client, developer, treasury, evidenceHash: HASH });
  const account = openAccount({
    id: '123e4567-e89b-12d3-a456-426614174000',
    taskAddress: task.toBase58(),
    termsHash: '00'.repeat(32),
    amount: '100000000',
    workDuration: '60',
    state: 'OPEN',
    clientWallet: client.toBase58(),
  });
  const balance = (accountAddress: string, pre: bigint, post: bigint): TokenBalanceChange => ({
    account: accountAddress,
    mint: 'mint',
    pre,
    post,
  });

  it('reads the fee and the payout from the balance changes', () => {
    const transaction = observed(
      [approve],
      [
        balance(escrow, 100_000_000n, 0n),
        balance(developerToken, 10n, 97_500_010n),
        balance(treasury.toBase58(), 0n, 2_500_000n),
      ],
    );
    const instruction = findTaskraInstruction(transaction, PROGRAM);
    expect(observedAmounts(transaction, instruction, account, escrow)).toEqual({
      fee: 2_500_000n,
      developer: 97_500_000n,
      client: 0n,
    });
    expect(tokenDelta(transaction, 'absent')).toBe(0n);
  });

  it('includes a stray deposit in what the developer received', () => {
    const transaction = observed(
      [approve],
      [
        balance(escrow, 100_000_007n, 0n),
        balance(developerToken, 0n, 97_500_007n),
        balance(treasury.toBase58(), 0n, 2_500_000n),
      ],
    );
    const instruction = findTaskraInstruction(transaction, PROGRAM);
    expect(observedAmounts(transaction, instruction, account, escrow).developer).toBe(97_500_007n);
  });

  it('splits one account that is both treasury and payout as the program does', () => {
    const same = approveTask(config, {
      task,
      client,
      developer,
      treasury: new PublicKey(developerToken),
      evidenceHash: HASH,
    });
    const transaction = observed(
      [same],
      [balance(escrow, 100_000_000n, 0n), balance(developerToken, 0n, 100_000_000n)],
    );
    const instruction = findTaskraInstruction(transaction, PROGRAM);
    expect(observedAmounts(transaction, instruction, account, escrow)).toEqual({
      fee: 2_500_000n,
      developer: 97_500_000n,
      client: 0n,
    });
  });

  it('throws when the movements do not add up to what left escrow', () => {
    const transaction = observed(
      [approve],
      [balance(escrow, 100_000_000n, 0n), balance(developerToken, 0n, 97_500_000n)],
    );
    const instruction = findTaskraInstruction(transaction, PROGRAM);
    expect(() => observedAmounts(transaction, instruction, account, escrow)).toThrow(
      /do not add up/,
    );
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
