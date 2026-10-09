import { createTaskraConfig } from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { buildApp } from './app.js';
import { createChainReader } from './chain/reader.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig(process.env);
const taskra = createTaskraConfig({
  cluster: config.SOLANA_NETWORK,
  usdcMint: config.USDC_MINT,
  programId: config.TASKRA_PROGRAM_ID,
});
const pool = createPool(config.DATABASE_URL, 'taskra_api');
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
