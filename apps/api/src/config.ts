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
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the web app is served over TLS, which is when the session cookie is `Secure`. */
export function servedOverHttps(config: Pick<ApiConfig, 'WEB_ORIGIN'>): boolean {
  return new URL(config.WEB_ORIGIN).protocol === 'https:';
}

function local(config: Pick<ApiConfig, 'WEB_ORIGIN'>): boolean {
  return LOOPBACK_HOSTS.has(new URL(config.WEB_ORIGIN).hostname);
}

const LOOPBACK_INTERFACES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True for anything that is not a developer's own machine: the web origin is
 * not a loopback address, the API listens on an interface other machines can
 * reach, or `NODE_ENV` says production. Any one of the three is enough, and
 * nothing switches the answer off. The stricter checks of this module and of
 * `startup.ts` apply then.
 */
export function isDeployed(
  config: Pick<ApiConfig, 'WEB_ORIGIN' | 'NODE_ENV' | 'API_HOST'>,
): boolean {
  return (
    !local(config) || !LOOPBACK_INTERFACES.has(config.API_HOST) || config.NODE_ENV === 'production'
  );
}

/**
 * Loads the API's configuration and refuses combinations that would silently
 * weaken it. These checks do not depend on `NODE_ENV` being set correctly:
 * what matters is where the web app is served from.
 *
 * - A web origin that is not this machine must use https. The session cookie
 *   is `Secure` exactly when the origin is https, so a deployed API can never
 *   hand out a session cookie that travels in clear text.
 * - The attester key must not be in this process's environment unless this is
 *   a developer's own machine (`isDeployed` is false: local development, where
 *   one `.env` serves every process; `discardForeignSecrets` then removes it).
 *   On any deployment its presence stops the API: the one signing key must
 *   never sit on the request-handling host.
 */
export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  const config = parseEnv('API', apiEnvSchema, source);
  const deployed = isDeployed(config);

  if (!local(config) && !servedOverHttps(config)) {
    throw new EnvValidationError('API', [
      { variable: 'WEB_ORIGIN', message: 'must use https unless it is a loopback address' },
    ]);
  }
  const present = source[ATTESTER_KEY];
  if (deployed && present !== undefined && present !== '') {
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
