import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WalletPanel } from '../components/Header';
import { type Api, ApiError, type Session } from '../lib/api';
import type { WalletPort } from '../lib/wallet';
import { FakeWallet } from '../testing/fakes';
import { AppProvider, createServices } from './app-context';

const ENV = {
  NEXT_PUBLIC_SOLANA_NETWORK: 'localnet',
  NEXT_PUBLIC_SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  NEXT_PUBLIC_TASKRA_PROGRAM_ID: '11111111111111111111111111111111',
  NEXT_PUBLIC_USDC_MINT: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  NEXT_PUBLIC_API_URL: 'http://localhost:4000',
} as const;

/** An API that verifies signatures the way the real one does. */
class FakeApi implements Partial<Api> {
  baseUrl = ENV.NEXT_PUBLIC_API_URL;
  current: Session | null = null;
  challenges = new Map<string, { wallet: string; message: string }>();
  logouts = 0;

  session = () => Promise.resolve(this.current);
  logout = () => {
    this.logouts += 1;
    this.current = null;
    return Promise.resolve();
  };
  challenge = (wallet: string) => {
    const nonce = `nonce-${String(this.challenges.size)}`;
    const message = `localhost:3000 wants you to sign in with your Solana account:\n${wallet}\n\nNonce: ${nonce}`;
    this.challenges.set(nonce, { wallet, message });
    return Promise.resolve({ nonce, message });
  };
  verify = (nonce: string, signature: string) => {
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (challenge === undefined) {
      return Promise.reject(new ApiError(401, 'INVALID_CHALLENGE', 'The challenge is not valid.'));
    }
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        bs58.decode(challenge.wallet),
      ]),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, Buffer.from(challenge.message), key, bs58.decode(signature))) {
      return Promise.reject(
        new ApiError(401, 'INVALID_SIGNATURE', 'The signature does not match the wallet.'),
      );
    }
    this.current = { wallet: challenge.wallet, expiresAt: 'later', github: null };
    return Promise.resolve(this.current);
  };
}

function mount(api: FakeApi, wallets: WalletPort[]) {
  const services = createServices(ENV, api as unknown as Api);
  const discover = (onChange: (found: WalletPort[]) => void) => {
    onChange(wallets);
    return () => undefined;
  };
  return render(
    <AppProvider services={services} discover={discover}>
      <WalletPanel />
    </AppProvider>,
  );
}

const status = () => screen.getByRole('status').getAttribute('data-status');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('wallet connection', () => {
  it('starts disconnected and says so when no wallet is installed', () => {
    mount(new FakeApi(), []);
    expect(status()).toBe('disconnected');
    expect(screen.getByText(/No Solana wallet was found/)).toBeTruthy();
  });

  it('connects, and being connected is not being signed in', async () => {
    const wallet = new FakeWallet();
    mount(new FakeApi(), [wallet]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }));
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
    expect(screen.getByText(/Connected, not signed in/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('shows a declined connection as an error and stays disconnected', async () => {
    const wallet = new FakeWallet();
    wallet.onConnect = 'reject';
    mount(new FakeApi(), [wallet]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/declined/);
    });
    expect(status()).toBe('disconnected');
    expect(window.localStorage.getItem('taskra:last-wallet')).toBeNull();
  });
});

describe('sign-in', () => {
  async function connected(api: FakeApi, wallet: FakeWallet) {
    mount(api, [wallet]);
    fireEvent.click(screen.getByRole('button', { name: `Connect ${wallet.name}` }));
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
  }

  it('signs the server challenge with the wallet and becomes signed in', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    await connected(api, wallet);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(status()).toBe('signed_in');
    });
    expect(wallet.signedMessages).toHaveLength(1);
    expect(wallet.signedMessages[0]).toContain(wallet.publicKey.toBase58());
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('stays signed out when the user declines the message', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    wallet.onSign = 'reject';
    await connected(api, wallet);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/declined/);
    });
    expect(status()).toBe('connected');
    expect(api.current).toBeNull();
  });

  it('stays signed out when the API rejects the signature', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    wallet.impostor = Keypair.generate();
    await connected(api, wallet);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/does not match the wallet/);
    });
    expect(status()).toBe('connected');
  });

  it('does not treat a session for another wallet as this wallet being signed in', async () => {
    const api = new FakeApi();
    api.current = { wallet: Keypair.generate().publicKey.toBase58(), expiresAt: 'later' };
    await connected(api, new FakeWallet());
    expect(status()).toBe('connected');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('disconnecting ends the session', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    await connected(api, wallet);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(status()).toBe('signed_in');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(status()).toBe('disconnected');
    });
    expect(api.logouts).toBe(1);
    expect(api.current).toBeNull();
  });
});

describe('refresh and reconnect', () => {
  it('reconnects the last wallet after a reload and restores the session', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    const first = mount(api, [wallet]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }));
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(status()).toBe('signed_in');
    });

    first.unmount(); // the page reloads; the cookie and localStorage survive
    mount(api, [wallet]);
    await waitFor(() => {
      expect(status()).toBe('signed_in');
    });
    expect(wallet.connects).toBe(2);
    // No second signature was needed.
    expect(wallet.signedMessages).toHaveLength(1);
  });

  it('does not reconnect a wallet the user disconnected', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    const first = mount(api, [wallet]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }));
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(status()).toBe('disconnected');
    });
    first.unmount();
    mount(api, [wallet]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toBe('disconnected');
    expect(wallet.connects).toBe(1);
  });

  it('shows a session that expired on the server as signed out after a reload', async () => {
    const api = new FakeApi();
    const wallet = new FakeWallet();
    const first = mount(api, [wallet]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }));
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(status()).toBe('signed_in');
    });
    first.unmount();
    api.current = null;
    mount(api, [wallet]);
    await waitFor(() => {
      expect(status()).toBe('connected');
    });
  });
});
