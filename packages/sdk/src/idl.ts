// Typed access to the program IDL. Addresses, seeds, discriminators and
// layouts used by the SDK come from here rather than being written twice.

import { PublicKey } from '@solana/web3.js';
import { TaskraSdkError } from './errors.js';
import { IDL } from './generated/idl.js';

export type IdlType =
  | 'u8'
  | 'u16'
  | 'u64'
  | 'i64'
  | 'pubkey'
  | { readonly array: readonly [IdlType, number] }
  | { readonly defined: { readonly name: string } };

export interface IdlField {
  readonly name: string;
  readonly type: IdlType;
}

export interface IdlInstructionAccount {
  readonly name: string;
  readonly writable?: boolean;
  readonly signer?: boolean;
  readonly optional?: boolean;
  readonly address?: string;
}

export interface IdlInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly accounts: readonly IdlInstructionAccount[];
  readonly args: readonly IdlField[];
}

export type IdlTypeDef =
  | { readonly kind: 'struct'; readonly fields: readonly IdlField[] }
  | { readonly kind: 'enum'; readonly variants: readonly { readonly name: string }[] };

const instructions: readonly IdlInstruction[] = IDL.instructions;
const types: readonly { readonly name: string; readonly type: IdlTypeDef }[] = IDL.types;
const accounts: readonly { readonly name: string; readonly discriminator: readonly number[] }[] =
  IDL.accounts;

export type InstructionName = (typeof IDL)['instructions'][number]['name'];

/** The program address the IDL was built for (`declare_id!`). */
export const PROGRAM_ID = new PublicKey(IDL.address);
export const IDL_PROGRAM_NAME: string = IDL.metadata.name;
export const IDL_PROGRAM_VERSION: string = IDL.metadata.version;
export const IDL_SPEC: string = IDL.metadata.spec;
export const INSTRUCTION_NAMES: readonly InstructionName[] = IDL.instructions.map(
  (instruction) => instruction.name,
);

export function getInstruction(name: InstructionName): IdlInstruction {
  const instruction = instructions.find((candidate) => candidate.name === name);
  if (instruction === undefined) {
    throw new TaskraSdkError('INVALID_ARGUMENT', `unknown instruction ${name}`);
  }
  return instruction;
}

export function getTypeDef(name: string): IdlTypeDef {
  const definition = types.find((candidate) => candidate.name === name);
  if (definition === undefined) {
    throw new TaskraSdkError('INVALID_ARGUMENT', `unknown IDL type ${name}`);
  }
  return definition.type;
}

export function getAccountDiscriminator(name: 'Platform' | 'Task'): Uint8Array {
  const account = accounts.find((candidate) => candidate.name === name);
  if (account === undefined) {
    throw new TaskraSdkError('INVALID_ARGUMENT', `unknown account ${name}`);
  }
  return Uint8Array.from(account.discriminator);
}

function seedConstant(name: string): Uint8Array {
  const constant = IDL.constants.find((candidate) => candidate.name === name);
  if (constant === undefined) {
    throw new TaskraSdkError('INVALID_ARGUMENT', `IDL constant ${name} is missing`);
  }
  return Uint8Array.from(JSON.parse(constant.value) as number[]);
}

export const PLATFORM_SEED = seedConstant('PLATFORM_SEED');
export const TASK_SEED = seedConstant('TASK_SEED');
export const ESCROW_SEED = seedConstant('ESCROW_SEED');

function fixedAddress(instruction: InstructionName, account: string): PublicKey {
  const address = getInstruction(instruction).accounts.find(
    (candidate) => candidate.name === account,
  )?.address;
  if (address === undefined) {
    throw new TaskraSdkError('INVALID_ARGUMENT', `IDL has no fixed address for ${account}`);
  }
  return new PublicKey(address);
}

/** The classic SPL Token program: the only token program the Taskra program accepts. */
export const TOKEN_PROGRAM_ID = fixedAddress('create_and_fund_task', 'token_program');
export const SYSTEM_PROGRAM_ID = fixedAddress('create_and_fund_task', 'system_program');

// The associated-token program appears in the IDL only as the owner of the
// derived destination accounts.
const associatedTokenProgramBytes = IDL.instructions
  .find((instruction) => instruction.name === 'approve_task')
  ?.accounts.find((account) => account.name === 'developer_token')?.pda.program.value;
if (associatedTokenProgramBytes === undefined) {
  throw new TaskraSdkError('INVALID_ARGUMENT', 'IDL has no associated-token program');
}
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  Uint8Array.from(associatedTokenProgramBytes),
);

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);
