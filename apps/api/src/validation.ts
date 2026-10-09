import bs58 from 'bs58';
import { z } from 'zod';

function base58Bytes(length: number) {
  return (value: string): boolean => {
    try {
      return bs58.decode(value).length === length;
    } catch {
      return false;
    }
  };
}

export const walletSchema = z
  .string()
  .max(44)
  .refine(base58Bytes(32), 'must be a base58 Solana address');

export const signatureSchema = z
  .string()
  .max(88)
  .refine(base58Bytes(64), 'must be a base58 64-byte signature');

/** A non-negative integer as a decimal string: amounts and durations never travel as numbers. */
export const decimalStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/, 'must be a decimal integer string');

export const uuidSchema = z.uuid();
