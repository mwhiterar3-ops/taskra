import { parseEnv, serverEnvSchema, type ServerEnv } from '@taskra/shared/env/server';

// The API validates exactly the variables it consumes. Each later phase widens
// this pick as it starts using more of the server environment contract.
const apiEnvSchema = serverEnvSchema.pick({
  NODE_ENV: true,
  API_HOST: true,
  API_PORT: true,
});

export type ApiConfig = Pick<ServerEnv, 'NODE_ENV' | 'API_HOST' | 'API_PORT'>;

export function loadApiConfig(source: Readonly<Record<string, string | undefined>>): ApiConfig {
  return parseEnv('API', apiEnvSchema, source);
}
