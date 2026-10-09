'use client';

// Wallet connection and wallet-authenticated session, in one place.
//
//   disconnected -> connecting -> connected -> signing_in -> signed_in
//
// "Connected" means the wallet shared an address. It proves nothing to the
// API; only "signed in" (a signature over a server challenge) does.

import { Connection, type PublicKey } from '@solana/web3.js';
import { createTaskraConfig, type TaskraConfig } from '@taskra/sdk';
import type { PublicEnv } from '@taskra/shared/env/public';
import bs58 from 'bs58';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Api, ApiError } from '../lib/api';
import { WalletError, type WalletPort } from '../lib/wallet';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'signing_in' | 'signed_in';

export interface AppServices {
  readonly env: PublicEnv;
  readonly api: Api;
  readonly connection: Connection;
  readonly taskra: TaskraConfig;
}

export interface AppState extends AppServices {
  readonly wallets: readonly WalletPort[];
  readonly status: WalletStatus;
  readonly wallet: WalletPort | null;
  readonly publicKey: PublicKey | null;
  /** The address, when connected. */
  readonly address: string | null;
  /** True only after the API verified a signature from this wallet. */
  readonly signedIn: boolean;
  readonly githubLogin: string | null;
  readonly error: string | null;
  readonly connect: (wallet: WalletPort) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  /** Signs the API's challenge. Resolves true when a session exists afterwards. */
  readonly signIn: () => Promise<boolean>;
  readonly refreshSession: () => Promise<void>;
}

const Context = createContext<AppState | null>(null);
const LAST_WALLET_KEY = 'taskra:last-wallet';

export function createServices(env: PublicEnv, api: Api): AppServices {
  return {
    env,
    api,
    connection: new Connection(env.NEXT_PUBLIC_SOLANA_RPC_URL, 'confirmed'),
    taskra: createTaskraConfig({
      cluster: env.NEXT_PUBLIC_SOLANA_NETWORK,
      usdcMint: env.NEXT_PUBLIC_USDC_MINT,
      programId: env.NEXT_PUBLIC_TASKRA_PROGRAM_ID,
    }),
  };
}

export interface AppProviderProps {
  readonly services: AppServices;
  /** Subscribes to the wallets available in this browser. */
  readonly discover: (onChange: (wallets: WalletPort[]) => void) => () => void;
  readonly children: ReactNode;
}

function describe(error: unknown): string {
  if (error instanceof WalletError || error instanceof ApiError) return error.message;
  return 'Something went wrong. Try again.';
}

export function AppProvider({ services, discover, children }: AppProviderProps) {
  const { api } = services;
  const [wallets, setWallets] = useState<readonly WalletPort[]>([]);
  const [wallet, setWallet] = useState<WalletPort | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState<'connecting' | 'signing_in' | null>(null);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  useEffect(() => discover(setWallets), [discover]);

  const refreshSession = useCallback(async () => {
    try {
      const session = await api.session();
      setSessionWallet(session?.wallet ?? null);
      setGithubLogin(session?.github?.login ?? null);
    } catch {
      // The API is unreachable: assume nothing about a session.
      setSessionWallet(null);
    }
  }, [api]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const connect = useCallback(async (target: WalletPort) => {
    setError(null);
    setBusy('connecting');
    try {
      const key = await target.connect();
      setWallet(target);
      setPublicKey(key);
      window.localStorage.setItem(LAST_WALLET_KEY, target.name);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
    }
  }, []);

  // After a reload, reconnect the wallet the user chose last time. A wallet
  // that already trusts this site reconnects silently; otherwise it asks.
  useEffect(() => {
    if (restored.current || wallets.length === 0) return;
    restored.current = true;
    const last = window.localStorage.getItem(LAST_WALLET_KEY);
    const match = wallets.find((candidate) => candidate.name === last);
    if (match !== undefined) void connect(match);
  }, [wallets, connect]);

  const disconnect = useCallback(async () => {
    window.localStorage.removeItem(LAST_WALLET_KEY);
    await wallet?.disconnect();
    setWallet(null);
    setPublicKey(null);
    setError(null);
    await api.logout().catch(() => undefined);
    setSessionWallet(null);
    setGithubLogin(null);
  }, [wallet, api]);

  const address = publicKey?.toBase58() ?? null;
  // A session for a different wallet than the connected one is not this user's.
  const signedIn = address !== null && sessionWallet === address;

  const signIn = useCallback(async (): Promise<boolean> => {
    if (wallet === null || address === null) {
      setError('Connect a wallet first.');
      return false;
    }
    if (signedIn) return true;
    setError(null);
    setBusy('signing_in');
    try {
      const challenge = await api.challenge(address);
      const signature = await wallet.signMessage(new TextEncoder().encode(challenge.message));
      const session = await api.verify(challenge.nonce, bs58.encode(signature));
      setSessionWallet(session.wallet);
      await refreshSession();
      return session.wallet === address;
    } catch (failure) {
      setError(describe(failure));
      return false;
    } finally {
      setBusy(null);
    }
  }, [wallet, address, signedIn, api, refreshSession]);

  const status: WalletStatus =
    busy ?? (address === null ? 'disconnected' : signedIn ? 'signed_in' : 'connected');

  const value = useMemo<AppState>(
    () => ({
      ...services,
      wallets,
      status,
      wallet,
      publicKey,
      address,
      signedIn,
      githubLogin: signedIn ? githubLogin : null,
      error,
      connect,
      disconnect,
      signIn,
      refreshSession,
    }),
    [
      services,
      wallets,
      status,
      wallet,
      publicKey,
      address,
      signedIn,
      githubLogin,
      error,
      connect,
      disconnect,
      signIn,
      refreshSession,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): AppState {
  const value = useContext(Context);
  if (value === null) throw new Error('useApp must be used inside AppProvider');
  return value;
}
