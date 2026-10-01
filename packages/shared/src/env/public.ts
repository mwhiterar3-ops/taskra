import { z } from 'zod';
import {
  type EnvSource,
  httpUrlSchema,
  parseEnv,
  solanaAddressSchema,
  solanaNetworkSchema,
} from './common.js';

/**
 * Variables that are inlined into the browser bundle. Everything here is
 * visible to every visitor, so nothing confidential may ever be added.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SOLANA_NETWORK: solanaNetworkSchema,
  NEXT_PUBLIC_SOLANA_RPC_URL: httpUrlSchema,
  NEXT_PUBLIC_TASKRA_PROGRAM_ID: solanaAddressSchema,
  NEXT_PUBLIC_USDC_MINT: solanaAddressSchema,
  NEXT_PUBLIC_API_URL: httpUrlSchema,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Next.js only inlines `process.env.NEXT_PUBLIC_*` when each variable is
 * referenced by its full static name, so callers must pass an object literal
 * listing every variable rather than `process.env` itself.
 */
export function loadPublicEnv(source: EnvSource): PublicEnv {
  return parseEnv('public', publicEnvSchema, source);
}
