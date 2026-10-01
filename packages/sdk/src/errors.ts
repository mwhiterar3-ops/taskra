import { IDL } from './generated/idl.js';

/** Raised by the SDK itself for bad inputs or undecodable data. */
export class TaskraSdkError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'INVALID_ACCOUNT_DATA' | 'ACCOUNT_NOT_FOUND';

  constructor(code: TaskraSdkError['code'], message: string) {
    super(message);
    this.name = 'TaskraSdkError';
    this.code = code;
  }
}

/** Every error the Taskra program can return, by its on-chain code. */
export const TASKRA_ERROR_CODES = {
  InvalidFeeBps: 6000,
  InvalidWindow: 6001,
  KeysNotSeparate: 6002,
  InvalidUpgradeAuthority: 6003,
  InvalidAmount: 6004,
  InvalidWorkDuration: 6005,
  ZeroHash: 6006,
  EscrowBalanceMismatch: 6007,
  InvalidState: 6008,
  Unauthorized: 6009,
  ClientCannotAccept: 6010,
  WorkDeadlinePassed: 6011,
  EvidenceMismatch: 6012,
  NonceMismatch: 6013,
  VerificationDeadlinePassed: 6014,
  ReviewDeadlinePassed: 6015,
  ReviewDeadlineNotPassed: 6016,
  DisputeWindowNotOpen: 6017,
  DisputeWindowClosed: 6018,
  RefundNotOpen: 6019,
  DisputeDeadlinePassed: 6020,
  DisputeDeadlineNotPassed: 6021,
  MissingOutcomeAccount: 6022,
  MathOverflow: 6023,
} as const;

export type TaskraErrorName = keyof typeof TASKRA_ERROR_CODES;

/**
 * The Anchor framework errors a Taskra transaction realistically produces:
 * account-constraint violations raised before the program's own checks run.
 */
export const ANCHOR_ERROR_CODES = {
  ConstraintMut: 2000,
  ConstraintSigner: 2002,
  ConstraintSeeds: 2006,
  ConstraintAssociated: 2009,
  ConstraintAddress: 2012,
  ConstraintTokenMint: 2014,
  ConstraintTokenOwner: 2015,
  ConstraintDuplicateMutableAccount: 2040,
  AccountDiscriminatorMismatch: 3002,
  AccountNotEnoughKeys: 3005,
  AccountNotInitialized: 3012,
  AccountOwnedByWrongProgram: 3007,
  InvalidProgramId: 3008,
  DeclaredProgramIdMismatch: 4100,
} as const;

export type AnchorErrorName = keyof typeof ANCHOR_ERROR_CODES;

export type DecodedProgramError =
  | {
      readonly kind: 'taskra';
      readonly code: number;
      readonly name: TaskraErrorName;
      readonly message: string;
    }
  | { readonly kind: 'anchor'; readonly code: number; readonly name: AnchorErrorName }
  | { readonly kind: 'unknown'; readonly code: number };

const taskraByCode = new Map<number, TaskraErrorName>(
  (Object.entries(TASKRA_ERROR_CODES) as [TaskraErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ]),
);
const anchorByCode = new Map<number, AnchorErrorName>(
  (Object.entries(ANCHOR_ERROR_CODES) as [AnchorErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ]),
);
const messageByCode = new Map<number, string>(IDL.errors.map((error) => [error.code, error.msg]));

/** Maps a custom program error code to a typed description. */
export function decodeErrorCode(code: number): DecodedProgramError {
  const taskra = taskraByCode.get(code);
  if (taskra !== undefined) {
    return { kind: 'taskra', code, name: taskra, message: messageByCode.get(code) ?? taskra };
  }
  const anchor = anchorByCode.get(code);
  if (anchor !== undefined) return { kind: 'anchor', code, name: anchor };
  return { kind: 'unknown', code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function codeFromText(text: string): number | null {
  const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(text)?.[1];
  if (hex !== undefined) return Number.parseInt(hex, 16);
  const decimal = /"Custom":\s*(\d+)/.exec(text)?.[1];
  return decimal === undefined ? null : Number.parseInt(decimal, 10);
}

/**
 * Finds the custom program error code in whatever an RPC call produced: a
 * bare code, a `TransactionError` (`{ InstructionError: [i, { Custom: n }] }`),
 * an object carrying `err` or `logs`, or an `Error` whose message quotes it.
 */
export function extractCustomErrorCode(error: unknown): number | null {
  if (typeof error === 'number') return Number.isInteger(error) ? error : null;
  if (typeof error === 'string') return codeFromText(error);
  if (!isRecord(error)) return null;

  const instructionError = error['InstructionError'];
  if (Array.isArray(instructionError)) {
    const detail: unknown = instructionError[1];
    if (isRecord(detail) && typeof detail['Custom'] === 'number') return detail['Custom'];
    return null;
  }
  if ('err' in error) {
    const nested = extractCustomErrorCode(error['err']);
    if (nested !== null) return nested;
  }
  const logs = error['logs'];
  if (Array.isArray(logs)) {
    for (const line of logs) {
      const code = typeof line === 'string' ? codeFromText(line) : null;
      if (code !== null) return code;
    }
  }
  const message = error['message'];
  return typeof message === 'string' ? codeFromText(message) : null;
}

/** `extractCustomErrorCode` followed by `decodeErrorCode`; null when no code is present. */
export function decodeProgramError(error: unknown): DecodedProgramError | null {
  const code = extractCustomErrorCode(error);
  return code === null ? null : decodeErrorCode(code);
}
