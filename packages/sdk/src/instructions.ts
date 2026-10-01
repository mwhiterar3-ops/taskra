// Unsigned instruction builders for all 14 program instructions
// (docs/13-DECISIONS.md §3.7). Account order, signer and writable flags, and
// argument layouts come from the IDL. Builders derive every PDA and associated
// token account themselves, so a caller cannot point an instruction at an
// account of their choosing; the program enforces the same constraints anyway.

import { Buffer } from 'buffer';
import { type PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter, encodeFields } from './borsh.js';
import { invalidArgument } from './bytes.js';
import type { TaskraConfig } from './config.js';
import { type DisputeResolution, idlVariantName } from './enums.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getInstruction,
  type InstructionName,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './idl.js';
import {
  findAssociatedTokenAddress,
  findEscrowAddress,
  findPlatformAddress,
  findProgramDataAddress,
  findTaskAddress,
} from './pda.js';

/** `null` omits an optional account (encoded, as Anchor expects, as the program id). */
type AccountInputs = Readonly<Record<string, PublicKey | null>>;

function buildInstruction(
  config: TaskraConfig,
  name: InstructionName,
  accounts: AccountInputs,
  args: Readonly<Record<string, unknown>>,
): TransactionInstruction {
  const instruction = getInstruction(name);
  const expected = new Set(instruction.accounts.map((account) => account.name));
  for (const provided of Object.keys(accounts)) {
    if (!expected.has(provided)) throw invalidArgument(`${name} has no account ${provided}`);
  }

  const keys = instruction.accounts.map((meta) => {
    if (meta.address !== undefined) {
      // Fixed addresses: the token and system programs, and the Taskra program itself.
      const pubkey =
        meta.address === PROGRAM_ID.toBase58() ? config.programId : fixedProgram(meta.address);
      return { pubkey, isSigner: false, isWritable: false };
    }
    const provided = accounts[meta.name];
    if (provided === undefined) throw invalidArgument(`${name} requires account ${meta.name}`);
    if (provided === null) {
      if (meta.optional !== true) throw invalidArgument(`${name}.${meta.name} is not optional`);
      return { pubkey: config.programId, isSigner: false, isWritable: false };
    }
    return {
      pubkey: provided,
      isSigner: meta.signer === true,
      isWritable: meta.writable === true,
    };
  });

  const writer = new BorshWriter();
  writer.raw(Uint8Array.from(instruction.discriminator));
  encodeFields(writer, instruction.args, args, name);
  return new TransactionInstruction({
    programId: config.programId,
    keys,
    data: Buffer.from(writer.toBytes()),
  });
}

function fixedProgram(address: string): PublicKey {
  if (address === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (address === SYSTEM_PROGRAM_ID.toBase58()) return SYSTEM_PROGRAM_ID;
  throw invalidArgument(`unexpected fixed account address ${address} in the IDL`);
}

function platform(config: TaskraConfig): PublicKey {
  return findPlatformAddress(config.programId)[0];
}

function escrow(config: TaskraConfig, task: PublicKey): PublicKey {
  return findEscrowAddress(config.programId, task)[0];
}

function usdcAccount(config: TaskraConfig, owner: PublicKey): PublicKey {
  return findAssociatedTokenAddress(owner, config.usdcMint);
}

// --- platform ---------------------------------------------------------------

export interface InitializePlatformParams {
  /** Signs and pays. Must be the program's upgrade authority. */
  readonly upgradeAuthority: PublicKey;
  /** USDC token account that will receive fees. */
  readonly treasury: PublicKey;
  readonly authority: PublicKey;
  readonly attester: PublicKey;
  readonly feeBps: number;
  readonly reviewWindow: bigint;
  readonly verificationGrace: bigint;
  readonly disputeTimeout: bigint;
}

export function initializePlatform(
  config: TaskraConfig,
  params: InitializePlatformParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    'initialize_platform',
    {
      upgrade_authority: params.upgradeAuthority,
      platform: platform(config),
      usdc_mint: config.usdcMint,
      treasury: params.treasury,
      program_data: findProgramDataAddress(config.programId)[0],
    },
    {
      args: {
        authority: params.authority,
        attester: params.attester,
        fee_bps: params.feeBps,
        review_window: params.reviewWindow,
        verification_grace: params.verificationGrace,
        dispute_timeout: params.disputeTimeout,
      },
    },
  );
}

export interface RotateKeysParams {
  /** Signs: the current platform authority. */
  readonly authority: PublicKey;
  /** Pass the current value of any key that should stay the same. */
  readonly newAuthority: PublicKey;
  readonly newAttester: PublicKey;
  readonly newTreasury: PublicKey;
}

export function rotateKeys(config: TaskraConfig, params: RotateKeysParams): TransactionInstruction {
  return buildInstruction(
    config,
    'rotate_keys',
    {
      authority: params.authority,
      platform: platform(config),
      usdc_mint: config.usdcMint,
      new_treasury: params.newTreasury,
      program_data: findProgramDataAddress(config.programId)[0],
    },
    { new_authority: params.newAuthority, new_attester: params.newAttester },
  );
}

// --- task lifecycle ---------------------------------------------------------

export interface CreateAndFundTaskParams {
  /** Signs and pays. */
  readonly client: PublicKey;
  /** 16 raw UUID bytes (see `taskIdFromUuid`). */
  readonly taskId: Uint8Array;
  /** Token base units. */
  readonly amount: bigint;
  /** Seconds the developer has after accepting. */
  readonly workDuration: bigint;
  readonly termsHash: Uint8Array;
  /** Funding source owned by the client. Defaults to the client's USDC ATA. */
  readonly clientTokenAccount?: PublicKey;
}

export function createAndFundTask(
  config: TaskraConfig,
  params: CreateAndFundTaskParams,
): TransactionInstruction {
  const task = findTaskAddress(config.programId, params.client, params.taskId)[0];
  return buildInstruction(
    config,
    'create_and_fund_task',
    {
      client: params.client,
      platform: platform(config),
      usdc_mint: config.usdcMint,
      client_token: params.clientTokenAccount ?? usdcAccount(config, params.client),
      task,
      escrow: escrow(config, task),
    },
    {
      task_id: params.taskId,
      amount: params.amount,
      work_duration: params.workDuration,
      terms_hash: params.termsHash,
    },
  );
}

export interface ClientRefundParams {
  /** Signs: the task's client. Receives the refund in their USDC ATA. */
  readonly client: PublicKey;
  readonly task: PublicKey;
}

function clientRefund(
  config: TaskraConfig,
  name: 'cancel_task' | 'refund_expired',
  params: ClientRefundParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    name,
    {
      client: params.client,
      platform: platform(config),
      task: params.task,
      usdc_mint: config.usdcMint,
      escrow: escrow(config, params.task),
      client_token: usdcAccount(config, params.client),
    },
    {},
  );
}

export function cancelTask(
  config: TaskraConfig,
  params: ClientRefundParams,
): TransactionInstruction {
  return clientRefund(config, 'cancel_task', params);
}

export function refundExpired(
  config: TaskraConfig,
  params: ClientRefundParams,
): TransactionInstruction {
  return clientRefund(config, 'refund_expired', params);
}

export interface DeveloperActionParams {
  /** Signs. */
  readonly developer: PublicKey;
  readonly task: PublicKey;
}

export function acceptTask(
  config: TaskraConfig,
  params: DeveloperActionParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    'accept_task',
    { developer: params.developer, platform: platform(config), task: params.task },
    {},
  );
}

export function submitWork(
  config: TaskraConfig,
  params: DeveloperActionParams & { readonly evidenceHash: Uint8Array },
): TransactionInstruction {
  return buildInstruction(
    config,
    'submit_work',
    { developer: params.developer, platform: platform(config), task: params.task },
    { evidence_hash: params.evidenceHash },
  );
}

export function openDeveloperDispute(
  config: TaskraConfig,
  params: DeveloperActionParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    'open_developer_dispute',
    { developer: params.developer, platform: platform(config), task: params.task },
    {},
  );
}

export interface RecordAttestationParams {
  /** Signs: the platform attester. */
  readonly attester: PublicKey;
  readonly task: PublicKey;
  readonly evidenceHash: Uint8Array;
  readonly submissionNonce: bigint;
}

export function recordAttestation(
  config: TaskraConfig,
  params: RecordAttestationParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    'record_attestation',
    { attester: params.attester, platform: platform(config), task: params.task },
    { evidence_hash: params.evidenceHash, submission_nonce: params.submissionNonce },
  );
}

/** The parties and fee destination a developer-paying settlement needs. */
export interface SettlementParties {
  readonly task: PublicKey;
  /** The task's recorded client; receives the escrow account's rent. */
  readonly client: PublicKey;
  /** The task's recorded developer; paid into their USDC ATA. */
  readonly developer: PublicKey;
  /** The platform's treasury token account (`PlatformAccount.treasury`). */
  readonly treasury: PublicKey;
}

export function approveTask(
  config: TaskraConfig,
  params: SettlementParties & { readonly evidenceHash: Uint8Array },
): TransactionInstruction {
  return buildInstruction(
    config,
    'approve_task',
    {
      client: params.client,
      platform: platform(config),
      task: params.task,
      usdc_mint: config.usdcMint,
      escrow: escrow(config, params.task),
      developer_token: usdcAccount(config, params.developer),
      treasury: params.treasury,
    },
    { evidence_hash: params.evidenceHash },
  );
}

export function rejectTask(
  config: TaskraConfig,
  params: {
    /** Signs: the task's client. */
    readonly client: PublicKey;
    readonly task: PublicKey;
    readonly reasonHash: Uint8Array;
  },
): TransactionInstruction {
  return buildInstruction(
    config,
    'reject_task',
    { client: params.client, platform: platform(config), task: params.task },
    { reason_hash: params.reasonHash },
  );
}

/** Permissionless: only the transaction's fee payer signs. */
export function expireReview(
  config: TaskraConfig,
  params: SettlementParties,
): TransactionInstruction {
  return buildInstruction(
    config,
    'expire_review',
    {
      platform: platform(config),
      task: params.task,
      usdc_mint: config.usdcMint,
      escrow: escrow(config, params.task),
      client: params.client,
      developer_token: usdcAccount(config, params.developer),
      treasury: params.treasury,
    },
    {},
  );
}

// --- disputes ---------------------------------------------------------------

/**
 * A dispute ends in exactly one of two ways. Each needs only its own
 * destination accounts, so the other branch's accounts are omitted.
 */
export type DisputeOutcomeAccounts =
  | {
      readonly outcome: 'PAY_DEVELOPER';
      readonly developer: PublicKey;
      readonly treasury: PublicKey;
    }
  | { readonly outcome: 'REFUND_CLIENT' };

function disputeAccounts(
  config: TaskraConfig,
  task: PublicKey,
  client: PublicKey,
  branch: DisputeOutcomeAccounts,
): AccountInputs {
  const paysDeveloper = branch.outcome === 'PAY_DEVELOPER';
  return {
    platform: platform(config),
    task,
    usdc_mint: config.usdcMint,
    escrow: escrow(config, task),
    client,
    client_token: paysDeveloper ? null : usdcAccount(config, client),
    developer_token: paysDeveloper ? usdcAccount(config, branch.developer) : null,
    treasury: paysDeveloper ? branch.treasury : null,
  };
}

export interface ResolveDisputeParams {
  /** Signs: the platform authority. */
  readonly authority: PublicKey;
  readonly task: PublicKey;
  /** The task's recorded client. */
  readonly client: PublicKey;
  readonly resolution: DisputeOutcomeAccounts;
}

export function resolveDispute(
  config: TaskraConfig,
  params: ResolveDisputeParams,
): TransactionInstruction {
  const resolution: DisputeResolution = params.resolution.outcome;
  return buildInstruction(
    config,
    'resolve_dispute',
    {
      authority: params.authority,
      ...disputeAccounts(config, params.task, params.client, params.resolution),
    },
    { resolution: idlVariantName(resolution) },
  );
}

export interface ExpireDisputeParams {
  readonly task: PublicKey;
  /** The task's recorded client. */
  readonly client: PublicKey;
  /**
   * The branch the program will take: `PAY_DEVELOPER` exactly when
   * `hasValidAttestation(task)`. This only selects which accounts to send; the
   * program decides the branch from its own state and rejects a mismatch.
   */
  readonly expected: DisputeOutcomeAccounts;
}

/** Permissionless: only the transaction's fee payer signs. */
export function expireDispute(
  config: TaskraConfig,
  params: ExpireDisputeParams,
): TransactionInstruction {
  return buildInstruction(
    config,
    'expire_dispute',
    disputeAccounts(config, params.task, params.client, params.expected),
    {},
  );
}

// --- supporting instruction -------------------------------------------------

/**
 * Creates `owner`'s USDC associated token account if it does not exist yet.
 * The Taskra program never creates destination accounts, so a settlement or
 * refund transaction should be preceded by this instruction.
 */
export function createUsdcAccountIdempotent(
  config: TaskraConfig,
  params: { readonly payer: PublicKey; readonly owner: PublicKey },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: usdcAccount(config, params.owner), isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: config.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // Associated-token program instruction 1: CreateIdempotent.
    data: Buffer.from([1]),
  });
}
