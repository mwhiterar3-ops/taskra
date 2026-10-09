// Everything the end-to-end run stands up: a platform on the local validator,
// a migrated PostgreSQL, the API listening on a real port, and the attestation
// service's worker. The API and the attester are the real application code;
// only GitHub is replaced.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMint, mintTo } from '@solana/spl-token';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import {
  createTaskraConfig,
  createUsdcAccountIdempotent,
  fetchPlatform,
  findAssociatedTokenAddress,
  type PlatformAccount,
  type TaskraConfig,
} from '@taskra/sdk';
import { createPool } from '@taskra/shared/db';
import { migrate, startTestPostgres } from '@taskra/shared/testing/postgres';
import pg from 'pg';
import { buildApp } from '../../api/src/app.js';
import { createChainReader } from '../../api/src/chain/reader.js';
import { createAttesterChain } from '../../attester/src/chain.js';
import { createGithubClient } from '../../attester/src/github.js';
import { createAttestationSigner } from '../../attester/src/signer.js';
import { assertConfiguredAttester } from '../../attester/src/startup.js';
import { createWorker, type Worker } from '../../attester/src/worker.js';
import {
  airdrop,
  initializePlatformOnChain,
  loadKeypair,
  requireEnv,
  send,
} from '../../../packages/sdk/e2e/lib.js';
import { note, section } from './check.js';
import { FakeGithub } from './fake-github.js';

export const WEB_ORIGIN = 'http://localhost:3000';

// Short-window test profile, as in the SDK validator loop. Not a deploy profile.
export const PROFILE = {
  feeBps: 250,
  reviewWindow: 10n,
  verificationGrace: 5n,
  disputeTimeout: 8n,
};

export interface World {
  readonly connection: Connection;
  readonly rpcUrl: string;
  readonly config: TaskraConfig;
  readonly platform: PlatformAccount;
  readonly apiUrl: string;
  readonly github: FakeGithub;
  /** Database owner, for assertions about what the services wrote. */
  readonly owner: pg.Pool;
  readonly databaseUrls: { readonly api: string; readonly attester: string };
  readonly attesterSecretKey: string;
  readonly authority: Keypair;
  /** An unrelated wallet that pays for permissionless instructions. */
  readonly cranker: Keypair;
  readonly worker: Worker;
  /** Gives `owner` a USDC account holding `amount` base units. */
  fundUsdc(owner: PublicKey, amount: bigint): Promise<void>;
  stop(): Promise<void>;
}

function withCredentials(url: string, database: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export async function createWorld(): Promise<World> {
  section('SETUP');
  const rpcUrl = requireEnv('RPC_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const upgradeAuthority = loadKeypair(requireEnv('TASKRA_UPGRADE_AUTHORITY_KEYPAIR'));
  const authority = Keypair.generate();
  const attester = Keypair.generate();
  const treasuryOwner = Keypair.generate();
  const mintAuthority = Keypair.generate();
  const cranker = Keypair.generate();
  for (const wallet of [upgradeAuthority, authority, attester, mintAuthority, cranker]) {
    await airdrop(connection, wallet.publicKey, 10);
  }

  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    6,
    undefined,
    {
      commitment: 'confirmed',
    },
  );
  const config = createTaskraConfig({ cluster: 'localnet', usdcMint: mint });
  await send(
    connection,
    'create the treasury token account',
    [
      createUsdcAccountIdempotent(config, {
        payer: cranker.publicKey,
        owner: treasuryOwner.publicKey,
      }),
    ],
    [cranker],
    'confirmed',
  );
  await initializePlatformOnChain(connection, config, upgradeAuthority, {
    treasury: findAssociatedTokenAddress(treasuryOwner.publicKey, mint),
    authority: authority.publicKey,
    attester: attester.publicKey,
    ...PROFILE,
  });
  const platform = await fetchPlatform(connection, config, 'finalized');
  note(`program ${config.programId.toBase58()}, mint ${mint.toBase58()}`);

  // PostgreSQL: one database, migrated, and one login per service that is a
  // member of only that service's role.
  const postgres = await startTestPostgres();
  const database = `taskra_e2e_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: postgres.adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const ownerUrl = withCredentials(
    postgres.adminUrl,
    database,
    new URL(postgres.adminUrl).username,
    decodeURIComponent(new URL(postgres.adminUrl).password),
  );
  await migrate(ownerUrl, fileURLToPath(new URL('../../api/migrations', import.meta.url)));
  const logins = { api: `e2e_api_${database}`, attester: `e2e_attester_${database}` };
  const passwords = {
    api: randomBytes(12).toString('hex'),
    attester: randomBytes(12).toString('hex'),
  };
  await admin.query(
    `CREATE ROLE ${logins.api} LOGIN PASSWORD '${passwords.api}' IN ROLE taskra_api`,
  );
  await admin.query(
    `CREATE ROLE ${logins.attester} LOGIN PASSWORD '${passwords.attester}' IN ROLE taskra_attester`,
  );
  const databaseUrls = {
    api: withCredentials(postgres.adminUrl, database, logins.api, passwords.api),
    attester: withCredentials(postgres.adminUrl, database, logins.attester, passwords.attester),
  };
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  note(`database ${database}, logins ${logins.api} and ${logins.attester}`);

  const github = new FakeGithub();
  const apiPool = createPool(databaseUrls.api, 'taskra_api');
  const app = await buildApp({
    config: {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 1,
      WEB_ORIGIN,
      SOLANA_NETWORK: 'localnet',
      SOLANA_RPC_URL: rpcUrl,
      TASKRA_PROGRAM_ID: config.programId.toBase58(),
      USDC_MINT: mint.toBase58(),
      DATABASE_URL: databaseUrls.api,
      GITHUB_CLIENT_ID: 'e2e-client-id',
      GITHUB_CLIENT_SECRET: 'e2e-client-secret',
    },
    taskra: config,
    pool: apiPool,
    chain: createChainReader(rpcUrl, config),
    fetch: github.fetch,
    now: () => new Date(),
    logger: false,
    rateLimit: true,
  });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  note(`API listening on ${apiUrl}`);

  const attesterSecretKey = JSON.stringify([...attester.secretKey]);
  const signer = createAttestationSigner(attesterSecretKey, config);
  const attesterChain = createAttesterChain(rpcUrl, config);
  await assertConfiguredAttester(attesterChain, signer);
  const attesterPool = createPool(databaseUrls.attester, 'taskra_attester');
  const worker = createWorker({
    pool: attesterPool,
    chain: attesterChain,
    github: createGithubClient({ fetch: github.fetch }),
    signer,
    now: () => new Date(),
    log: {
      info: () => undefined,
      warn: (fields, message) => {
        note(
          `attester warning: ${message} ${JSON.stringify(fields['reason'] ?? fields['error'] ?? '')}`,
        );
      },
      error: (fields, message) => {
        note(`attester error: ${message} ${JSON.stringify(fields)}`);
      },
    },
  });
  // The service's loop, as in apps/attester/src/main.ts.
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void worker
      .tick()
      .catch((error: unknown) => {
        note(`attester tick failed: ${String(error)}`);
      })
      .finally(() => {
        ticking = false;
      });
  }, 1_000);
  note(`attestation service running as ${attester.publicKey.toBase58()}`);

  return {
    connection,
    rpcUrl,
    config,
    platform,
    apiUrl,
    github,
    owner,
    databaseUrls,
    attesterSecretKey,
    authority,
    cranker,
    worker,
    async fundUsdc(target, amount) {
      await send(
        connection,
        'create a USDC account',
        [createUsdcAccountIdempotent(config, { payer: cranker.publicKey, owner: target })],
        [cranker],
        'confirmed',
      );
      if (amount > 0n) {
        await mintTo(
          connection,
          mintAuthority,
          mint,
          findAssociatedTokenAddress(target, mint),
          mintAuthority,
          amount,
          [],
          { commitment: 'confirmed' },
        );
      }
    },
    async stop() {
      clearInterval(timer);
      await app.close();
      await Promise.all([apiPool.end(), attesterPool.end(), owner.end()]);
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${logins.api}`);
      await admin.query(`DROP ROLE IF EXISTS ${logins.attester}`);
      await admin.end();
      await postgres.stop();
    },
  };
}
