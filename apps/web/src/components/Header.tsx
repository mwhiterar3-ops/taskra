'use client';

import Link from 'next/link';
import { shortAddress } from '../lib/amounts';
import { useApp } from '../state/app-context';

const STATUS_TEXT = {
  disconnected: 'Wallet disconnected',
  connecting: 'Connecting to your wallet…',
  connected: 'Connected, not signed in',
  signing_in: 'Waiting for you to sign the sign-in message…',
  signed_in: 'Signed in',
} as const;

export function WalletPanel() {
  const app = useApp();
  const busy = app.status === 'connecting' || app.status === 'signing_in';

  return (
    <div className="wallet" aria-label="Wallet">
      <p className="wallet-status" role="status" aria-live="polite" data-status={app.status}>
        {STATUS_TEXT[app.status]}
        {app.address !== null && <span className="mono"> · {shortAddress(app.address)}</span>}
      </p>
      {app.address === null ? (
        app.wallets.length === 0 ? (
          <p className="muted">No Solana wallet was found in this browser.</p>
        ) : (
          <div className="row">
            {app.wallets.map((wallet) => (
              <button
                key={wallet.name}
                type="button"
                disabled={busy}
                onClick={() => void app.connect(wallet)}
              >
                Connect {wallet.name}
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="row">
          {!app.signedIn && (
            <button type="button" disabled={busy} onClick={() => void app.signIn()}>
              Sign in
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void app.disconnect()}
          >
            Disconnect
          </button>
        </div>
      )}
      {app.error !== null && (
        <p className="notice notice-error" role="alert">
          {app.error}
        </p>
      )}
    </div>
  );
}

export function Header() {
  const { address, env } = useApp();
  return (
    <header className="header">
      <nav aria-label="Main">
        <Link href="/" className="brand">
          Taskra
        </Link>
        <Link href="/tasks">Tasks</Link>
        <Link href="/tasks/new">Create task</Link>
        <Link href="/dashboard/client">Client</Link>
        <Link href="/dashboard/developer">Developer</Link>
        {address !== null && <Link href={`/profile/${address}`}>Profile</Link>}
        <span className="network">{env.NEXT_PUBLIC_SOLANA_NETWORK}</span>
      </nav>
      <WalletPanel />
    </header>
  );
}
