import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discriminator } from './__fixtures__/fixtures.js';
import { IDL } from './generated/idl.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ESCROW_SEED,
  getAccountDiscriminator,
  IDL_SPEC,
  INSTRUCTION_NAMES,
  PLATFORM_SEED,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TASK_SEED,
  TOKEN_PROGRAM_ID,
} from './idl.js';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('IDL', () => {
  it('is the IDL of the current program build', () => {
    const built = new URL('../../../target/idl/taskra.json', import.meta.url);
    // target/ is git-ignored; on a checkout without a program build there is
    // nothing to compare against, and `pnpm anchor:build` produces it.
    if (!existsSync(built)) {
      console.warn('target/idl/taskra.json not found; skipping the staleness check');
      return;
    }
    expect(IDL).toEqual(JSON.parse(readFileSync(built, 'utf8')));
  });

  it('has the expected shape', () => {
    expect(IDL_SPEC).toBe('0.1.0');
    expect(IDL.metadata.name).toBe('taskra');
    expect(IDL.instructions).toHaveLength(14);
    expect(IDL.errors).toHaveLength(24);
    expect(IDL.accounts.map((account) => account.name)).toEqual(['Platform', 'Task']);
    expect(PROGRAM_ID.toBase58()).toBe(IDL.address);
  });

  it('lists the 14 instructions of docs/13-DECISIONS.md §3.7', () => {
    expect([...INSTRUCTION_NAMES].sort()).toEqual([
      'accept_task',
      'approve_task',
      'cancel_task',
      'create_and_fund_task',
      'expire_dispute',
      'expire_review',
      'initialize_platform',
      'open_developer_dispute',
      'record_attestation',
      'refund_expired',
      'reject_task',
      'resolve_dispute',
      'rotate_keys',
      'submit_work',
    ]);
  });

  it('derives seeds and program addresses from the IDL', () => {
    expect(text(PLATFORM_SEED)).toBe('platform');
    expect(text(TASK_SEED)).toBe('task');
    expect(text(ESCROW_SEED)).toBe('escrow');
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(SYSTEM_PROGRAM_ID.toBase58()).toBe('11111111111111111111111111111111');
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
  });

  it('carries discriminators that match Anchor’s derivation', () => {
    for (const instruction of IDL.instructions) {
      expect(Uint8Array.from(instruction.discriminator), instruction.name).toEqual(
        discriminator('global', instruction.name),
      );
    }
    expect(getAccountDiscriminator('Task')).toEqual(discriminator('account', 'Task'));
    expect(getAccountDiscriminator('Platform')).toEqual(discriminator('account', 'Platform'));
  });
});
