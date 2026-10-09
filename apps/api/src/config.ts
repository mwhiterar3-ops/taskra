import { EnvValidationError, parseEnv, serverEnvSchema } from '@taskra/shared/env/server';
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

const ATTESTER_KEY = 'ATTESTER_SECRET_KEY';

/**
 * Loads the API's configuration.
 *
 * In production the API refuses to start if the attester key is in its
 * environment at all: that is a deployment mistake that puts the one signing
 * key on the request-handling host. In development, where one `.env` file
 * serves every process, the key is tolerated here and removed from the
 * process by `discardForeignSecrets`.
 */
export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  const config = parseEnv('API', apiEnvSchema, source);
  const present = source[ATTESTER_KEY];
  if (config.NODE_ENV === 'production' && present !== undefined && present !== '') {
    throw new EnvValidationError('API', [
      {
        variable: ATTESTER_KEY,
        message: 'must not be present in the API environment; it belongs to apps/attester only',
      },
    ]);
  }
  return config;
}

/** Removes secrets that belong to other processes from this process's environment. */
export function discardForeignSecrets(environment: Record<string, string | undefined>): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a fixed key
  delete environment[ATTESTER_KEY];
}
