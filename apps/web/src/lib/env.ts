import { loadPublicEnv, type PublicEnv } from '@taskra/shared/env/public';

export type EnvResult =
  { readonly ok: true; readonly env: PublicEnv } | { readonly ok: false; readonly problem: string };

let cached: EnvResult | null = null;

/**
 * The public configuration, validated once. Next.js inlines `NEXT_PUBLIC_*`
 * only when each variable is named literally, so they are listed here. A build
 * made without them still loads, and says what is missing instead of guessing
 * a program id or a mint.
 */
export function readEnv(): EnvResult {
  if (cached !== null) return cached;
  try {
    cached = {
      ok: true,
      env: loadPublicEnv({
        NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK,
        NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
        NEXT_PUBLIC_TASKRA_PROGRAM_ID: process.env.NEXT_PUBLIC_TASKRA_PROGRAM_ID,
        NEXT_PUBLIC_USDC_MINT: process.env.NEXT_PUBLIC_USDC_MINT,
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      }),
    };
  } catch (error) {
    cached = {
      ok: false,
      problem: error instanceof Error ? error.message : 'invalid configuration',
    };
  }
  return cached;
}

export function explorerUrl(env: PublicEnv, kind: 'tx' | 'address', value: string): string {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet-beta') return base;
  if (env.NEXT_PUBLIC_SOLANA_NETWORK === 'devnet') return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(env.NEXT_PUBLIC_SOLANA_RPC_URL)}`;
}
