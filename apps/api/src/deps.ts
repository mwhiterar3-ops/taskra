import type { TaskraConfig } from '@taskra/sdk';
import type pg from 'pg';
import type { ChainReader } from './chain/reader.js';
import type { ApiConfig } from './config.js';

/** Everything the API reaches outside its own process. Tests substitute each part. */
export interface AppDeps {
  readonly config: ApiConfig;
  readonly taskra: TaskraConfig;
  /** Connections already dropped to the `taskra_api` role. */
  readonly pool: pg.Pool;
  readonly chain: ChainReader;
  /** Outbound HTTP (GitHub OAuth only). */
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly logger: boolean;
  /** Off only in tests that are not about rate limiting. */
  readonly rateLimit: boolean;
}
