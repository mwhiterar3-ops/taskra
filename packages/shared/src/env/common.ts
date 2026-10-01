import bs58 from 'bs58';
import { z } from 'zod';

export const solanaNetworkSchema = z.enum(['localnet', 'devnet', 'mainnet-beta']);
export type SolanaNetwork = z.infer<typeof solanaNetworkSchema>;

/** A base58 string that decodes to exactly 32 bytes (a Solana address). */
export const solanaAddressSchema = z.string().refine(
  (value) => {
    try {
      return bs58.decode(value).length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be a base58-encoded 32-byte Solana address' },
);

export const httpUrlSchema = z.url({ protocol: /^https?$/ });

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvIssue {
  readonly variable: string;
  readonly message: string;
}

/**
 * Raised when environment variables fail validation. The message names the
 * offending variables and the rule they broke; it never contains their values.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(scope: string, issues: readonly EnvIssue[]) {
    const lines = issues.map((issue) => `  ${issue.variable}: ${issue.message}`);
    super(`Invalid ${scope} environment:\n${lines.join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates `source` against `schema`. Empty strings are treated as unset, so a
 * blank line copied from `.env.example` fails as "missing" rather than passing
 * as an empty value.
 */
export function parseEnv<Schema extends z.ZodType>(
  scope: string,
  schema: Schema,
  source: EnvSource,
): z.output<Schema> {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new EnvValidationError(
      scope,
      result.error.issues.map((issue) => {
        const variable = issue.path.join('.');
        return { variable, message: variable in present ? issue.message : 'is required' };
      }),
    );
  }
  return result.data;
}
