import { TaskraSdkError } from './errors.js';

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MAX = (1n << 63n) - 1n;
export const I64_MIN = -(1n << 63n);

export function invalidArgument(message: string): TaskraSdkError {
  return new TaskraSdkError('INVALID_ARGUMENT', message);
}

/** Requires an integer `bigint` in `[min, max]`. Numbers are rejected: no silent precision loss. */
export function requireBigIntInRange(
  value: unknown,
  min: bigint,
  max: bigint,
  name: string,
): bigint {
  if (typeof value !== 'bigint') {
    throw invalidArgument(`${name} must be a bigint`);
  }
  if (value < min || value > max) {
    throw invalidArgument(`${name} is out of range`);
  }
  return value;
}

export function requireU64(value: unknown, name: string): bigint {
  return requireBigIntInRange(value, 0n, U64_MAX, name);
}

export function requireI64(value: unknown, name: string): bigint {
  return requireBigIntInRange(value, I64_MIN, I64_MAX, name);
}

export function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw invalidArgument(`${name} must be exactly ${String(length)} bytes`);
  }
  return value;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw invalidArgument('expected an even-length hexadecimal string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}
