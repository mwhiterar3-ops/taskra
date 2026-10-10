import { createTaskraConfig } from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { buildApp } from './app.js';
import { createChainReader } from './chain/reader.js';
import { discardForeignSecrets, isDeployed, loadApiConfig } from './config.js';
import { assertConfinedDatabaseLogin } from './startup.js';

const config = loadApiConfig(process.env);
discardForeignSecrets(process.env);
const taskra = createTaskraConfig({
  cluster: config.SOLANA_NETWORK,
  usdcMint: config.USDC_MINT,
  programId: config.TASKRA_PROGRAM_ID,
});
const pool = createPool(config.DATABASE_URL, 'taskra_api');
// Only on a developer's own machine may one login serve the migrations and
// every process. There is no setting that skips this check anywhere else, and
// a check that cannot be completed (no connection, no schema) is a refusal.
if (isDeployed(config)) {
  try {
    await assertConfinedDatabaseLogin(pool);
  } catch (error) {
    console.error(`refusing to start: ${error instanceof Error ? error.message : 'unknown'}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}
const app = await buildApp({
  config,
  taskra,
  pool,
  chain: createChainReader(config.SOLANA_RPC_URL, taskra),
  fetch,
  now: () => new Date(),
  logger: config.NODE_ENV !== 'test',
  rateLimit: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
