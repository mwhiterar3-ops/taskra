import { parseEnv, serverEnvSchema } from '@taskra/shared/env/server';
import type { z } from 'zod';

// The API validates exactly the variables it consumes. ATTESTER_SECRET_KEY is
// deliberately absent: the attester key never enters this process
// (docs/14-API-CONTRACT.md §6). The GitHub OAuth app is optional so the API can
// run before one exists; linking a GitHub identity is then unavailable.
const apiEnvSchema = serverEnvSchema
  .pick({
    NODE_ENV: true,
    API_HOST: true,
    API_PORT: true,
    WEB_ORIGIN: true,
    SOLANA_NETWORK: true,
    SOLANA_RPC_URL: true,
    TASKRA_PROGRAM_ID: true,
    USDC_MINT: true,
    DATABASE_URL: true,
    GITHUB_CLIENT_ID: true,
    GITHUB_CLIENT_SECRET: true,
  })
  .partial({ GITHUB_CLIENT_ID: true, GITHUB_CLIENT_SECRET: true });

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  return parseEnv('API', apiEnvSchema, source);
}
