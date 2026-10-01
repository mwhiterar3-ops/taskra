// Borsh encoding and decoding driven by the IDL's type descriptions.
//
// Value conventions: `u8`/`u16` are numbers, `u64`/`i64` are bigints,
// `pubkey` is a `PublicKey`, byte arrays are `Uint8Array`, structs are plain
// objects keyed by the IDL's field names, enums are the IDL variant name.

import { PublicKey } from '@solana/web3.js';
import { invalidArgument, requireBytes, requireI64, requireU64 } from './bytes.js';
import { TaskraSdkError } from './errors.js';
import { getTypeDef, type IdlField, type IdlType } from './idl.js';

export type BorshValue =
  number | bigint | string | PublicKey | Uint8Array | { readonly [field: string]: BorshValue };

export class BorshWriter {
  private readonly bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value);
  }

  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  u64(value: bigint): void {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setBigUint64(0, value, true);
    this.raw(new Uint8Array(buffer.buffer));
  }

  i64(value: bigint): void {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setBigInt64(0, value, true);
    this.raw(new Uint8Array(buffer.buffer));
  }

  raw(value: Uint8Array): void {
    for (const byte of value) this.bytes.push(byte);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class BorshReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  private advance(length: number): number {
    if (this.remaining < length) {
      throw new TaskraSdkError('INVALID_ACCOUNT_DATA', 'account data is shorter than its layout');
    }
    const start = this.offset;
    this.offset += length;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  u16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.advance(8), true);
  }

  i64(): bigint {
    return this.view.getBigInt64(this.advance(8), true);
  }

  raw(length: number): Uint8Array {
    const start = this.advance(length);
    return this.data.slice(start, start + length);
  }
}

function requireInteger(value: unknown, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalidArgument(`${name} must be an integer between 0 and ${String(max)}`);
  }
  return value;
}

export function encodeType(writer: BorshWriter, type: IdlType, value: unknown, name: string): void {
  if (type === 'u8') {
    writer.u8(requireInteger(value, 0xff, name));
  } else if (type === 'u16') {
    writer.u16(requireInteger(value, 0xffff, name));
  } else if (type === 'u64') {
    writer.u64(requireU64(value, name));
  } else if (type === 'i64') {
    writer.i64(requireI64(value, name));
  } else if (type === 'pubkey') {
    if (!(value instanceof PublicKey)) throw invalidArgument(`${name} must be a PublicKey`);
    writer.raw(value.toBytes());
  } else if ('array' in type) {
    const [element, length] = type.array;
    if (element !== 'u8') throw invalidArgument(`${name}: only byte arrays are supported`);
    writer.raw(requireBytes(value, length, name));
  } else {
    const definition = getTypeDef(type.defined.name);
    if (definition.kind === 'enum') {
      const index = definition.variants.findIndex((variant) => variant.name === value);
      if (index < 0) throw invalidArgument(`${name} is not a ${type.defined.name} variant`);
      writer.u8(index);
    } else {
      if (typeof value !== 'object' || value === null) {
        throw invalidArgument(`${name} must be an object`);
      }
      encodeFields(writer, definition.fields, value as Record<string, unknown>, name);
    }
  }
}

export function encodeFields(
  writer: BorshWriter,
  fields: readonly IdlField[],
  values: Readonly<Record<string, unknown>>,
  name: string,
): void {
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw invalidArgument(`${name} has no field ${key}`);
  }
  for (const field of fields) {
    encodeType(writer, field.type, values[field.name], `${name}.${field.name}`);
  }
}

export function decodeType(reader: BorshReader, type: IdlType): BorshValue {
  if (type === 'u8') return reader.u8();
  if (type === 'u16') return reader.u16();
  if (type === 'u64') return reader.u64();
  if (type === 'i64') return reader.i64();
  if (type === 'pubkey') return new PublicKey(reader.raw(32));
  if ('array' in type) {
    const [element, length] = type.array;
    if (element !== 'u8') {
      throw new TaskraSdkError('INVALID_ACCOUNT_DATA', 'only byte arrays are supported');
    }
    return reader.raw(length);
  }
  const definition = getTypeDef(type.defined.name);
  if (definition.kind === 'enum') {
    const variant = definition.variants[reader.u8()];
    if (variant === undefined) {
      throw new TaskraSdkError('INVALID_ACCOUNT_DATA', `invalid ${type.defined.name} variant`);
    }
    return variant.name;
  }
  return decodeFields(reader, definition.fields);
}

export function decodeFields(
  reader: BorshReader,
  fields: readonly IdlField[],
): Record<string, BorshValue> {
  const result: Record<string, BorshValue> = {};
  for (const field of fields) result[field.name] = decodeType(reader, field.type);
  return result;
}
