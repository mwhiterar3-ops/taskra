'use client';

import { type ReactNode, useCallback, useMemo } from 'react';
import { createApi } from '../lib/api';
import { readEnv } from '../lib/env';
import { discoverWallets, type WalletPort } from '../lib/wallet';
import { AppProvider, createServices } from '../state/app-context';
import { Header } from './Header';

export function Providers({ children }: { readonly children: ReactNode }) {
  const result = readEnv();
  const services = useMemo(
    () =>
      result.ok ? createServices(result.env, createApi(result.env.NEXT_PUBLIC_API_URL)) : null,
    [result],
  );
  const network = result.ok ? result.env.NEXT_PUBLIC_SOLANA_NETWORK : 'devnet';
  const discover = useCallback(
    (onChange: (wallets: WalletPort[]) => void) => discoverWallets(network, onChange),
    [network],
  );

  if (services === null) {
    return (
      <main className="page">
        <h1>Taskra is not configured</h1>
        <p>
          This build has no valid public configuration, so it cannot know which program, token or
          API to use. Set the <code>NEXT_PUBLIC_*</code> variables described in{' '}
          <code>docs/10-ENVIRONMENT-SPEC.md</code> and rebuild.
        </p>
        <pre className="notice notice-error">{result.ok ? '' : result.problem}</pre>
      </main>
    );
  }
  return (
    <AppProvider services={services} discover={discover}>
      <Header />
      <main className="page">{children}</main>
    </AppProvider>
  );
}
