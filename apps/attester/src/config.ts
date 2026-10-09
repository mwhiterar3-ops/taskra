import { parseEnv, serverEnvSchema } from '@taskra/shared/env/server';
import type { z } from 'zod';

// This is the only process that reads ATTESTER_SECRET_KEY. It has no HTTP
// listener: nothing can ask it to sign. It takes work from the database queue
// and re-derives every fact before signing (docs/14-API-CONTRACT.md §6).
// The GitHub OAuth app credentials are optional here; when present they only
// raise the rate limit of the public REST calls.
const attesterEnvSchema = serverEnvSchema
  .pick({
    NODE_ENV: true,
    SOLANA_NETWORK: true,
    SOLANA_RPC_URL: true,
    TASKRA_PROGRAM_ID: true,
    USDC_MINT: true,
    DATABASE_URL: true,
    ATTESTER_SECRET_KEY: true,
    GITHUB_CLIENT_ID: true,
    GITHUB_CLIENT_SECRET: true,
  })
  .partial({ GITHUB_CLIENT_ID: true, GITHUB_CLIENT_SECRET: true });

export type AttesterConfig = z.infer<typeof attesterEnvSchema>;

export function loadAttesterConfig(
  source: Readonly<Record<string, string | undefined>>,
): AttesterConfig {
  return parseEnv('attester', attesterEnvSchema, source);
}
