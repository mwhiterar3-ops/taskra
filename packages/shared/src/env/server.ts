import { z } from 'zod';
import {
  type EnvSource,
  httpUrlSchema,
  parseEnv,
  solanaAddressSchema,
  solanaNetworkSchema,
} from './common.js';

/** Variables read only by server processes. Never import this from browser code. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  WEB_ORIGIN: httpUrlSchema,
  SOLANA_NETWORK: solanaNetworkSchema,
  SOLANA_RPC_URL: httpUrlSchema,
  TASKRA_PROGRAM_ID: solanaAddressSchema,
  USDC_MINT: solanaAddressSchema,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(source: EnvSource): ServerEnv {
  return parseEnv('server', serverEnvSchema, source);
}

export { EnvValidationError, parseEnv } from './common.js';
