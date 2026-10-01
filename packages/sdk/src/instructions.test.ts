// Every builder is checked against a hand-written expectation: account order,
// signer and writable flags, and the exact argument bytes. The expectations do
// not read the IDL, so a wrong IDL-driven builder cannot agree with them by
// construction.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ATTESTER,
  AUTHORITY,
  bytes32,
  CLIENT,
  concat,
  CONFIG,
  DEVELOPER,
  discriminator,
  i64le,
  key,
  MINT,
  TASK_UUID,
  TREASURY,
  u16le,
  u64le,
  UPGRADE_AUTHORITY,
} from './__fixtures__/fixtures.js';
import { TaskraSdkError } from './errors.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  INSTRUCTION_NAMES,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './idl.js';
import {
  acceptTask,
  approveTask,
  cancelTask,
  createAndFundTask,
  createUsdcAccountIdempotent,
  expireDispute,
  expireReview,
  initializePlatform,
  openDeveloperDispute,
  recordAttestation,
  refundExpired,
  rejectTask,
  resolveDispute,
  rotateKeys,
  submitWork,
} from './instructions.js';
import {
  findAssociatedTokenAddress,
  findEscrowAddress,
  findPlatformAddress,
  findProgramDataAddress,
  findTaskAddress,
  taskIdFromUuid,
} from './pda.js';

const TASK_ID = taskIdFromUuid(TASK_UUID);
const PLATFORM = findPlatformAddress(PROGRAM_ID)[0];
const TASK = findTaskAddress(PROGRAM_ID, CLIENT, TASK_ID)[0];
const ESCROW = findEscrowAddress(PROGRAM_ID, TASK)[0];
const PROGRAM_DATA = findProgramDataAddress(PROGRAM_ID)[0];
const CLIENT_ATA = findAssociatedTokenAddress(CLIENT, MINT);
const DEVELOPER_ATA = findAssociatedTokenAddress(DEVELOPER, MINT);
const EVIDENCE = bytes32(0xe1);
const TERMS = bytes32(0x7e);
const REASON = bytes32(0x4e);

type Flags = '' | 's' | 'w' | 'sw';
type Expected = readonly (readonly [PublicKey, Flags])[];

function expectInstruction(
  instruction: TransactionInstruction,
  name: string,
  accounts: Expected,
  args: Uint8Array,
): void {
  expect(instruction.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
  expect(
    instruction.keys.map((meta) => [
      meta.pubkey.toBase58(),
      `${meta.isSigner ? 's' : ''}${meta.isWritable ? 'w' : ''}`,
    ]),
  ).toEqual(accounts.map(([pubkey, flags]) => [pubkey.toBase58(), flags]));
  expect(Uint8Array.from(instruction.data)).toEqual(concat(discriminator('global', name), args));
}

const none = new Uint8Array(0);
const covered = new Set<string>();
function covers(name: string): string {
  covered.add(name);
  return name;
}

describe('instruction builders', () => {
  it(covers('initialize_platform'), () => {
    const instruction = initializePlatform(CONFIG, {
      upgradeAuthority: UPGRADE_AUTHORITY,
      treasury: TREASURY,
      authority: AUTHORITY,
      attester: ATTESTER,
      feeBps: 250,
      reviewWindow: 172_800n,
      verificationGrace: 86_400n,
      disputeTimeout: 604_800n,
    });
    expectInstruction(
      instruction,
      'initialize_platform',
      [
        [UPGRADE_AUTHORITY, 'sw'],
        [PLATFORM, 'w'],
        [MINT, ''],
        [TREASURY, ''],
        [PROGRAM_ID, ''],
        [PROGRAM_DATA, ''],
        [SYSTEM_PROGRAM_ID, ''],
      ],
      concat(
        AUTHORITY.toBytes(),
        ATTESTER.toBytes(),
        u16le(250),
        i64le(172_800n),
        i64le(86_400n),
        i64le(604_800n),
      ),
    );
  });

  it(covers('rotate_keys'), () => {
    const newAuthority = key(21);
    const newAttester = key(22);
    const newTreasury = key(23);
    expectInstruction(
      rotateKeys(CONFIG, { authority: AUTHORITY, newAuthority, newAttester, newTreasury }),
      'rotate_keys',
      [
        [AUTHORITY, 's'],
        [PLATFORM, 'w'],
        [MINT, ''],
        [newTreasury, ''],
        [PROGRAM_ID, ''],
        [PROGRAM_DATA, ''],
      ],
      concat(newAuthority.toBytes(), newAttester.toBytes()),
    );
  });

  it(covers('create_and_fund_task'), () => {
    const params = {
      client: CLIENT,
      taskId: TASK_ID,
      amount: 100_000_000n,
      workDuration: 259_200n,
      termsHash: TERMS,
    };
    const accounts = (source: PublicKey): Expected => [
      [CLIENT, 'sw'],
      [PLATFORM, ''],
      [MINT, ''],
      [source, 'w'],
      [TASK, 'w'],
      [ESCROW, 'w'],
      [TOKEN_PROGRAM_ID, ''],
      [SYSTEM_PROGRAM_ID, ''],
    ];
    const args = concat(TASK_ID, u64le(100_000_000n), i64le(259_200n), TERMS);
    expectInstruction(
      createAndFundTask(CONFIG, params),
      'create_and_fund_task',
      accounts(CLIENT_ATA),
      args,
    );

    // An explicit funding account replaces the default associated account.
    const other = key(31);
    expectInstruction(
      createAndFundTask(CONFIG, { ...params, clientTokenAccount: other }),
      'create_and_fund_task',
      accounts(other),
      args,
    );
  });

  it.each([
    [covers('cancel_task'), cancelTask],
    [covers('refund_expired'), refundExpired],
  ] as const)('%s', (name, build) => {
    expectInstruction(
      build(CONFIG, { client: CLIENT, task: TASK }),
      name,
      [
        [CLIENT, 'sw'],
        [PLATFORM, ''],
        [TASK, 'w'],
        [MINT, ''],
        [ESCROW, 'w'],
        [CLIENT_ATA, 'w'],
        [TOKEN_PROGRAM_ID, ''],
      ],
      none,
    );
  });

  const developerAccounts: Expected = [
    [DEVELOPER, 's'],
    [PLATFORM, ''],
    [TASK, 'w'],
  ];

  it(covers('accept_task'), () => {
    expectInstruction(
      acceptTask(CONFIG, { developer: DEVELOPER, task: TASK }),
      'accept_task',
      developerAccounts,
      none,
    );
  });

  it(covers('submit_work'), () => {
    expectInstruction(
      submitWork(CONFIG, { developer: DEVELOPER, task: TASK, evidenceHash: EVIDENCE }),
      'submit_work',
      developerAccounts,
      EVIDENCE,
    );
  });

  it(covers('open_developer_dispute'), () => {
    expectInstruction(
      openDeveloperDispute(CONFIG, { developer: DEVELOPER, task: TASK }),
      'open_developer_dispute',
      developerAccounts,
      none,
    );
  });

  it(covers('record_attestation'), () => {
    const instruction = recordAttestation(CONFIG, {
      attester: ATTESTER,
      task: TASK,
      evidenceHash: EVIDENCE,
      submissionNonce: 3n,
    });
    expectInstruction(
      instruction,
      'record_attestation',
      [
        [ATTESTER, 's'],
        [PLATFORM, ''],
        [TASK, 'w'],
      ],
      concat(EVIDENCE, u64le(3n)),
    );
    // The attestation instruction touches no token account at all.
    const tokenAccounts = [ESCROW, CLIENT_ATA, DEVELOPER_ATA, TREASURY, TOKEN_PROGRAM_ID];
    for (const meta of instruction.keys) {
      expect(tokenAccounts.some((account) => account.equals(meta.pubkey))).toBe(false);
    }
  });

  const parties = { task: TASK, client: CLIENT, developer: DEVELOPER, treasury: TREASURY };

  it(covers('approve_task'), () => {
    expectInstruction(
      approveTask(CONFIG, { ...parties, evidenceHash: EVIDENCE }),
      'approve_task',
      [
        [CLIENT, 'sw'],
        [PLATFORM, ''],
        [TASK, 'w'],
        [MINT, ''],
        [ESCROW, 'w'],
        [DEVELOPER_ATA, 'w'],
        [TREASURY, 'w'],
        [TOKEN_PROGRAM_ID, ''],
      ],
      EVIDENCE,
    );
  });

  it(covers('reject_task'), () => {
    expectInstruction(
      rejectTask(CONFIG, { client: CLIENT, task: TASK, reasonHash: REASON }),
      'reject_task',
      [
        [CLIENT, 's'],
        [PLATFORM, ''],
        [TASK, 'w'],
      ],
      REASON,
    );
  });

  it(`${covers('expire_review')} has no signer`, () => {
    const instruction = expireReview(CONFIG, parties);
    expectInstruction(
      instruction,
      'expire_review',
      [
        [PLATFORM, ''],
        [TASK, 'w'],
        [MINT, ''],
        [ESCROW, 'w'],
        [CLIENT, 'w'],
        [DEVELOPER_ATA, 'w'],
        [TREASURY, 'w'],
        [TOKEN_PROGRAM_ID, ''],
      ],
      none,
    );
    expect(instruction.keys.some((meta) => meta.isSigner)).toBe(false);
  });

  // An omitted optional account is encoded as the program id, read-only.
  const payDeveloperTail: Expected = [
    [PROGRAM_ID, ''],
    [DEVELOPER_ATA, 'w'],
    [TREASURY, 'w'],
    [TOKEN_PROGRAM_ID, ''],
  ];
  const refundClientTail: Expected = [
    [CLIENT_ATA, 'w'],
    [PROGRAM_ID, ''],
    [PROGRAM_ID, ''],
    [TOKEN_PROGRAM_ID, ''],
  ];
  const disputeHead: Expected = [
    [PLATFORM, ''],
    [TASK, 'w'],
    [MINT, ''],
    [ESCROW, 'w'],
    [CLIENT, 'w'],
  ];
  const payDeveloper = {
    outcome: 'PAY_DEVELOPER',
    developer: DEVELOPER,
    treasury: TREASURY,
  } as const;

  it(covers('resolve_dispute'), () => {
    expectInstruction(
      resolveDispute(CONFIG, {
        authority: AUTHORITY,
        task: TASK,
        client: CLIENT,
        resolution: payDeveloper,
      }),
      'resolve_dispute',
      [[AUTHORITY, 's'], ...disputeHead, ...payDeveloperTail],
      Uint8Array.of(0),
    );
    expectInstruction(
      resolveDispute(CONFIG, {
        authority: AUTHORITY,
        task: TASK,
        client: CLIENT,
        resolution: { outcome: 'REFUND_CLIENT' },
      }),
      'resolve_dispute',
      [[AUTHORITY, 's'], ...disputeHead, ...refundClientTail],
      Uint8Array.of(1),
    );
  });

  it(`${covers('expire_dispute')} has no signer`, () => {
    const pay = expireDispute(CONFIG, { task: TASK, client: CLIENT, expected: payDeveloper });
    expectInstruction(pay, 'expire_dispute', [...disputeHead, ...payDeveloperTail], none);
    const refund = expireDispute(CONFIG, {
      task: TASK,
      client: CLIENT,
      expected: { outcome: 'REFUND_CLIENT' },
    });
    expectInstruction(refund, 'expire_dispute', [...disputeHead, ...refundClientTail], none);
    for (const instruction of [pay, refund]) {
      expect(instruction.keys.some((meta) => meta.isSigner)).toBe(false);
    }
  });

  it('has a builder test for every instruction in the IDL', () => {
    expect([...covered].sort()).toEqual([...INSTRUCTION_NAMES].sort());
  });

  it('builds the idempotent associated-token-account instruction', () => {
    const payer = key(41);
    const instruction = createUsdcAccountIdempotent(CONFIG, { payer, owner: DEVELOPER });
    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(
      instruction.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]),
    ).toEqual([
      [payer.toBase58(), true, true],
      [DEVELOPER_ATA.toBase58(), false, true],
      [DEVELOPER.toBase58(), false, false],
      [MINT.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ]);
    expect([...instruction.data]).toEqual([1]);
  });
});

describe('malformed builder inputs', () => {
  const base = {
    client: CLIENT,
    taskId: TASK_ID,
    amount: 1n,
    workDuration: 1n,
    termsHash: TERMS,
  };

  it.each([
    ['a 15-byte task id', { taskId: new Uint8Array(15) }],
    ['a 31-byte terms hash', { termsHash: new Uint8Array(31) }],
    ['a negative amount', { amount: -1n }],
    ['an amount above u64', { amount: 1n << 64n }],
    ['a number amount', { amount: 100 as unknown as bigint }],
    ['a fractional amount', { amount: 1.5 as unknown as bigint }],
    ['a duration above i64', { workDuration: 1n << 63n }],
    ['a number duration', { workDuration: 60 as unknown as bigint }],
  ])('create_and_fund_task rejects %s', (_, override) => {
    expect(() => createAndFundTask(CONFIG, { ...base, ...override })).toThrow(TaskraSdkError);
  });

  it('accepts the extremes of u64 and i64', () => {
    const instruction = createAndFundTask(CONFIG, {
      ...base,
      amount: (1n << 64n) - 1n,
      workDuration: (1n << 63n) - 1n,
    });
    const data = Uint8Array.from(instruction.data);
    expect(data.slice(8 + 16, 8 + 16 + 8)).toEqual(new Uint8Array(8).fill(0xff));
    expect(data.slice(8 + 16 + 8, 8 + 16 + 16)).toEqual(
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f),
    );
  });

  it('rejects wrong-length hashes and bad nonces', () => {
    expect(() =>
      submitWork(CONFIG, { developer: DEVELOPER, task: TASK, evidenceHash: new Uint8Array(33) }),
    ).toThrow(TaskraSdkError);
    expect(() =>
      rejectTask(CONFIG, { client: CLIENT, task: TASK, reasonHash: new Uint8Array(0) }),
    ).toThrow(TaskraSdkError);
    expect(() =>
      recordAttestation(CONFIG, {
        attester: ATTESTER,
        task: TASK,
        evidenceHash: EVIDENCE,
        submissionNonce: -1n,
      }),
    ).toThrow(TaskraSdkError);
  });

  it('rejects out-of-range platform arguments', () => {
    const params = {
      upgradeAuthority: UPGRADE_AUTHORITY,
      treasury: TREASURY,
      authority: AUTHORITY,
      attester: ATTESTER,
      feeBps: 250,
      reviewWindow: 1n,
      verificationGrace: 1n,
      disputeTimeout: 1n,
    };
    expect(() => initializePlatform(CONFIG, { ...params, feeBps: 70_000 })).toThrow(TaskraSdkError);
    expect(() => initializePlatform(CONFIG, { ...params, feeBps: 2.5 })).toThrow(TaskraSdkError);
    expect(() =>
      initializePlatform(CONFIG, { ...params, reviewWindow: 48 as unknown as bigint }),
    ).toThrow(TaskraSdkError);
  });
});
