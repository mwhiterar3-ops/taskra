// The wallet boundary. Everything the app needs from a wallet is these four
// operations; the private key never leaves the wallet, and nothing here is
// ever sent to the API except signatures the wallet chose to produce.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

export interface WalletPort {
  readonly name: string;
  readonly icon: string | null;
  /** Asks the user to connect. Rejects with `WalletError`. */
  connect(): Promise<PublicKey>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

export class WalletError extends Error {
  constructor(
    /** `rejected`: the user declined. `failed`: the wallet could not do it. */
    readonly kind: 'rejected' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Wallets differ in how they say "the user said no". */
export function toWalletError(error: unknown, doing: string): WalletError {
  if (error instanceof WalletError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message)) {
    return new WalletError('rejected', `You declined ${doing} in your wallet.`);
  }
  return new WalletError('failed', `Your wallet could not finish ${doing}.`);
}

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const SIGN_MESSAGE = 'solana:signMessage';
const SIGN_TRANSACTION = 'solana:signTransaction';

interface StandardFeatures {
  [CONNECT]: { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
  [DISCONNECT]?: { disconnect(): Promise<void> };
  [SIGN_MESSAGE]: {
    signMessage(input: {
      account: WalletAccount;
      message: Uint8Array;
    }): Promise<readonly { signature: Uint8Array }[]>;
  };
  [SIGN_TRANSACTION]: {
    signTransaction(input: {
      account: WalletAccount;
      transaction: Uint8Array;
      chain: string;
    }): Promise<readonly { signedTransaction: Uint8Array }[]>;
  };
}

export function isUsable(wallet: Wallet): boolean {
  return [CONNECT, SIGN_MESSAGE, SIGN_TRANSACTION].every((feature) => feature in wallet.features);
}

/** Adapts a Wallet Standard wallet. `network` is `localnet`, `devnet` or `mainnet-beta`. */
export function fromStandardWallet(wallet: Wallet, network: string): WalletPort {
  const features = wallet.features as unknown as StandardFeatures;
  const chain = `solana:${network === 'mainnet-beta' ? 'mainnet' : network}`;
  let account: WalletAccount | null = null;
  const connected = (): WalletAccount => {
    if (account === null) throw new WalletError('failed', 'The wallet is not connected.');
    return account;
  };

  return {
    name: wallet.name,
    icon: wallet.icon,
    async connect() {
      try {
        const result = await features[CONNECT].connect();
        account = result.accounts[0] ?? wallet.accounts[0] ?? null;
      } catch (error) {
        throw toWalletError(error, 'the connection');
      }
      return new PublicKey(connected().publicKey);
    },
    async disconnect() {
      account = null;
      await features[DISCONNECT]?.disconnect().catch(() => undefined);
    },
    async signMessage(message) {
      try {
        const [output] = await features[SIGN_MESSAGE].signMessage({
          account: connected(),
          message,
        });
        if (output === undefined) throw new Error('no signature returned');
        return output.signature;
      } catch (error) {
        throw toWalletError(error, 'the sign-in message');
      }
    },
    async signTransaction(transaction) {
      try {
        const [output] = await features[SIGN_TRANSACTION].signTransaction({
          account: connected(),
          transaction: transaction.serialize(),
          chain,
        });
        if (output === undefined) throw new Error('no transaction returned');
        return VersionedTransaction.deserialize(output.signedTransaction);
      } catch (error) {
        throw toWalletError(error, 'the transaction');
      }
    },
  };
}

/** The usable wallets installed in this browser, and a way to hear about new ones. */
export function discoverWallets(
  network: string,
  onChange: (wallets: WalletPort[]) => void,
): () => void {
  const registry = getWallets();
  const emit = () => {
    onChange(
      registry
        .get()
        .filter(isUsable)
        .map((wallet) => fromStandardWallet(wallet, network)),
    );
  };
  emit();
  const offRegister = registry.on('register', emit);
  const offUnregister = registry.on('unregister', emit);
  return () => {
    offRegister();
    offUnregister();
  };
}
