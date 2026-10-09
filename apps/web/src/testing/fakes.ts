// Test doubles for the browser side: a wallet backed by a throwaway keypair
// (so signatures are real) and an RPC endpoint that follows a script.

import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, type PublicKey, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { TxRpc } from '../lib/transaction';
import { WalletError, type WalletPort } from '../lib/wallet';

export class FakeWallet implements WalletPort {
  readonly name: string;
  readonly icon = null;
  readonly keypair = Keypair.generate();
  /** What the user does when the wallet asks. */
  onConnect: 'approve' | 'reject' = 'approve';
  onSign: 'approve' | 'reject' = 'approve';
  connects = 0;
  signedMessages: string[] = [];
  signedTransactions = 0;
  /** When set, message signatures come from this key instead (a wallet that lies). */
  impostor: Keypair | null = null;

  constructor(name = 'Test Wallet') {
    this.name = name;
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  connect(): Promise<PublicKey> {
    this.connects += 1;
    return this.onConnect === 'reject'
      ? Promise.reject(new WalletError('rejected', 'You declined the connection in your wallet.'))
      : Promise.resolve(this.keypair.publicKey);
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (this.onSign === 'reject') {
      return Promise.reject(
        new WalletError('rejected', 'You declined the sign-in message in your wallet.'),
      );
    }
    this.signedMessages.push(new TextDecoder().decode(message));
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        (this.impostor ?? this.keypair).secretKey.subarray(0, 32),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    return Promise.resolve(new Uint8Array(sign(null, message, key)));
  }

  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    if (this.onSign === 'reject') {
      return Promise.reject(
        new WalletError('rejected', 'You declined the transaction in your wallet.'),
      );
    }
    this.signedTransactions += 1;
    transaction.sign([this.keypair]);
    return Promise.resolve(transaction);
  }
}

type Status = { err: unknown; confirmationStatus: string } | null;

export class FakeRpc implements TxRpc {
  /** Thrown by `sendRawTransaction` when set. */
  sendError: Error | null = null;
  /** One entry is consumed per status poll; the last one repeats. An Error entry is thrown. */
  statuses: (Status | Error)[] = [{ err: null, confirmationStatus: 'finalized' }];
  blockHeight = 100;
  readonly sent: string[] = [];
  polls = 0;

  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return Promise.resolve({
      blockhash: bs58.encode(new Uint8Array(32).fill(5)),
      lastValidBlockHeight: 150,
    });
  }

  sendRawTransaction(raw: Uint8Array): Promise<string> {
    if (this.sendError !== null) return Promise.reject(this.sendError);
    this.sent.push(bs58.encode(raw.subarray(1, 65)));
    return Promise.resolve(this.sent.at(-1) ?? '');
  }

  getSignatureStatuses(): Promise<{ value: Status[] }> {
    const next = this.statuses[Math.min(this.polls, this.statuses.length - 1)] ?? null;
    this.polls += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ value: [next] });
  }

  getBlockHeight(): Promise<number> {
    return Promise.resolve(this.blockHeight);
  }
}
