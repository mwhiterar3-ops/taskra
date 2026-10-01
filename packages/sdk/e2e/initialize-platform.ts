// Initializes the Taskra platform on the cluster at RPC_URL. Used by
// scripts/deploy-devnet.sh after the program is deployed, and by the local
// validator loop. Configuration comes entirely from the environment:
//
//   RPC_URL                          cluster RPC endpoint
//   TASKRA_CLUSTER                   localnet | devnet | mainnet-beta
//   USDC_MINT                        USDC mint of that cluster
//   TASKRA_UPGRADE_AUTHORITY_KEYPAIR path to the program upgrade authority keypair (signs)
//   TASKRA_PLATFORM_AUTHORITY        platform authority address
//   TASKRA_ATTESTER                  attester address
//   TASKRA_TREASURY_TOKEN_ACCOUNT    USDC token account that receives fees
//   TASKRA_FEE_BPS                   fee in basis points
//   TASKRA_REVIEW_WINDOW             seconds
//   TASKRA_VERIFICATION_GRACE        seconds
//   TASKRA_DISPUTE_TIMEOUT           seconds
//
// The windows are permanent: they cannot be changed after this transaction.

import { Connection } from '@solana/web3.js';
import {
  type Cluster,
  CLUSTERS,
  createTaskraConfig,
  fetchPlatform,
  maxClientLockSeconds,
} from '../src/index.js';
import {
  envBigInt,
  envPublicKey,
  initializePlatformOnChain,
  loadKeypair,
  requireEnv,
} from './lib.js';

const cluster = requireEnv('TASKRA_CLUSTER');
if (!CLUSTERS.includes(cluster as Cluster)) {
  throw new Error(`TASKRA_CLUSTER must be one of ${CLUSTERS.join(', ')}`);
}
const feeBps = Number(envBigInt('TASKRA_FEE_BPS'));

const connection = new Connection(requireEnv('RPC_URL'), 'confirmed');
const config = createTaskraConfig({
  cluster: cluster as Cluster,
  usdcMint: envPublicKey('USDC_MINT'),
});
const upgradeAuthority = loadKeypair(requireEnv('TASKRA_UPGRADE_AUTHORITY_KEYPAIR'));

console.log(`Initializing the Taskra platform on ${cluster}`);
console.log(`  program            ${config.programId.toBase58()}`);
console.log(`  usdc mint          ${config.usdcMint.toBase58()}`);
console.log(`  upgrade authority  ${upgradeAuthority.publicKey.toBase58()}`);

await initializePlatformOnChain(connection, config, upgradeAuthority, {
  treasury: envPublicKey('TASKRA_TREASURY_TOKEN_ACCOUNT'),
  authority: envPublicKey('TASKRA_PLATFORM_AUTHORITY'),
  attester: envPublicKey('TASKRA_ATTESTER'),
  feeBps,
  reviewWindow: envBigInt('TASKRA_REVIEW_WINDOW'),
  verificationGrace: envBigInt('TASKRA_VERIFICATION_GRACE'),
  disputeTimeout: envBigInt('TASKRA_DISPUTE_TIMEOUT'),
});

const platform = await fetchPlatform(connection, config, 'finalized');
console.log('Platform state (finalized):');
console.log(`  authority           ${platform.authority.toBase58()}`);
console.log(`  attester            ${platform.attester.toBase58()}`);
console.log(`  treasury            ${platform.treasury.toBase58()}`);
console.log(`  fee_bps             ${String(platform.feeBps)}`);
console.log(`  review_window       ${String(platform.reviewWindow)} s`);
console.log(`  verification_grace  ${String(platform.verificationGrace)} s`);
console.log(`  dispute_timeout     ${String(platform.disputeTimeout)} s`);
console.log(
  `  max client lock     work_duration + ${String(maxClientLockSeconds(0n, platform))} s`,
);
