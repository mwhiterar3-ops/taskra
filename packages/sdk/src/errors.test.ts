import { describe, expect, it } from 'vitest';
import {
  ANCHOR_ERROR_CODES,
  decodeErrorCode,
  decodeProgramError,
  extractCustomErrorCode,
  TASKRA_ERROR_CODES,
} from './errors.js';
import { IDL } from './generated/idl.js';

describe('program error mapping', () => {
  it('maps every error code in the IDL, by name', () => {
    expect(IDL.errors).toHaveLength(24);
    for (const error of IDL.errors) {
      expect(decodeErrorCode(error.code), error.name).toEqual({
        kind: 'taskra',
        code: error.code,
        name: error.name,
        message: error.msg,
      });
    }
  });

  it('maps nothing the IDL does not define', () => {
    const idl = Object.fromEntries(IDL.errors.map((error) => [error.name, error.code]));
    expect(TASKRA_ERROR_CODES).toEqual(idl);
  });

  it('has no duplicate codes', () => {
    const codes = [...Object.values(TASKRA_ERROR_CODES), ...Object.values(ANCHOR_ERROR_CODES)];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('maps the Anchor constraint errors a Taskra transaction can produce', () => {
    expect(decodeErrorCode(2012)).toEqual({
      kind: 'anchor',
      code: 2012,
      name: 'ConstraintAddress',
    });
    expect(decodeErrorCode(2015)).toEqual({
      kind: 'anchor',
      code: 2015,
      name: 'ConstraintTokenOwner',
    });
    expect(decodeErrorCode(3012)).toEqual({
      kind: 'anchor',
      code: 3012,
      name: 'AccountNotInitialized',
    });
  });

  it('reports unknown codes as unknown instead of guessing', () => {
    expect(decodeErrorCode(1)).toEqual({ kind: 'unknown', code: 1 });
    expect(decodeErrorCode(6024)).toEqual({ kind: 'unknown', code: 6024 });
  });
});

describe('extractCustomErrorCode', () => {
  it.each([
    ['a bare code', 6008, 6008],
    ['a TransactionError', { InstructionError: [0, { Custom: 6009 }] }, 6009],
    ['a confirmation result', { err: { InstructionError: [2, { Custom: 6012 }] } }, 6012],
    ['an error with a hex message', new Error('custom program error: 0x1778'), 6008],
    [
      'transaction logs',
      { logs: ['Program log: x', 'Program X failed: custom program error: 0x1779'] },
      6009,
    ],
    ['a JSON-ish message', { message: '{"InstructionError":[0,{"Custom":6013}]}' }, 6013],
    ['a string', 'failed: custom program error: 0x7df', 2015],
  ])('reads %s', (_, input, code) => {
    expect(extractCustomErrorCode(input)).toBe(code);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-custom instruction error', { InstructionError: [0, 'InvalidAccountData'] }],
    ['an unrelated error', new Error('blockhash not found')],
    ['a fractional number', 1.5],
    ['an empty object', {}],
  ])('returns null for %s', (_, input) => {
    expect(extractCustomErrorCode(input)).toBeNull();
    expect(decodeProgramError(input)).toBeNull();
  });

  it('decodes straight to a typed error', () => {
    expect(decodeProgramError({ InstructionError: [0, { Custom: 6019 }] })).toEqual({
      kind: 'taskra',
      code: 6019,
      name: 'RefundNotOpen',
      message: 'The refund is not available yet',
    });
  });
});
