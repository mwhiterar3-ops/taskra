import { createTaskraConfig } from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { pino } from 'pino';
import { createAttesterChain } from './chain.js';
import { loadAttesterConfig } from './config.js';
import { createGithubClient } from './github.js';
import { createAttestationSigner } from './signer.js';
import { assertConfiguredAttester } from './startup.js';
import { createWorker } from './worker.js';

const POLL_INTERVAL_MS = 3_000;

const config = loadAttesterConfig(process.env);
const log = pino({ name: 'taskra-attester', redact: ['err.config', 'err.request'] });
const taskra = createTaskraConfig({
  cluster: config.SOLANA_NETWORK,
  usdcMint: config.USDC_MINT,
  programId: config.TASKRA_PROGRAM_ID,
});
const signer = createAttestationSigner(config.ATTESTER_SECRET_KEY, taskra);
const chain = createAttesterChain(config.SOLANA_RPC_URL, taskra);
const pool = createPool(config.DATABASE_URL, 'taskra_attester');

try {
  await assertConfiguredAttester(chain, signer);
} catch (error) {
  log.error({ reason: error instanceof Error ? error.message : 'unknown' }, 'refusing to start');
  await pool.end();
  process.exit(1);
}

const worker = createWorker({
  pool,
  chain,
  github: createGithubClient({
    fetch,
    ...(config.GITHUB_CLIENT_ID !== undefined && config.GITHUB_CLIENT_SECRET !== undefined
      ? { credentials: { id: config.GITHUB_CLIENT_ID, secret: config.GITHUB_CLIENT_SECRET } }
      : {}),
  }),
  signer,
  now: () => new Date(),
  log,
});

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown.abort();
  });
}

log.info(
  { attester: signer.publicKey.toBase58(), network: config.SOLANA_NETWORK },
  'attester started',
);
while (!shutdown.signal.aborted) {
  try {
    await worker.tick();
  } catch (error) {
    log.error({ err: error }, 'tick failed');
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
await pool.end();
log.info({}, 'attester stopped');
