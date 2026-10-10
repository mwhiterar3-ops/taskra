// An in-memory ChainReader for tests. It models the two things the API relies
// on: an account or transaction is visible at `confirmed` before it is visible
// at `finalized`, and the RPC endpoint can be down.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { PlatformAccount, TaskAccount, TaskraCommitment } from '@taskra/sdk';
import type { InnerInstruction, ObservedTransaction } from '../chain/parse.js';
import {
  type ChainReader,
  ChainUnavailableError,
  type SignatureStatus,
  type TaskSnapshot,
} from '../chain/reader.js';

interface TaskEntry {
  confirmed: { account: TaskAccount; slot: number } | null;
  finalized: { account: TaskAccount; slot: number } | null;
}

interface TransactionEntry {
  transaction: ObservedTransaction;
  finalized: boolean;
}

export interface TransactionFixture {
  readonly signature: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly error?: unknown;
  /** Inner instructions by the index of the top-level instruction that made them. */
  readonly inner?: Readonly<Record<number, readonly InnerInstruction[]>>;
  /** Models an RPC node that does not report inner instructions at all. */
  readonly innerMissing?: boolean;
}

export class FakeChain implements ChainReader {
  available = true;
  slot = 1_000;
  platform: PlatformAccount | null = null;
  readonly tasks = new Map<string, TaskEntry>();
  readonly transactions = new Map<string, TransactionEntry>();

  private guard(operation: string): void {
    if (!this.available) throw new ChainUnavailableError(operation, new Error('fake outage'));
  }

  /** Records the account as seen at `confirmed`, and also at `finalized` when asked. */
  setTask(address: PublicKey, account: TaskAccount, options: { finalized: boolean }): void {
    this.slot += 1;
    const entry = this.tasks.get(address.toBase58()) ?? { confirmed: null, finalized: null };
    entry.confirmed = { account, slot: this.slot };
    if (options.finalized) entry.finalized = entry.confirmed;
    this.tasks.set(address.toBase58(), entry);
  }

  /** A fork: the confirmed-only view of the account is discarded. */
  rollBackTask(address: PublicKey): void {
    const entry = this.tasks.get(address.toBase58());
    if (entry !== undefined) entry.confirmed = entry.finalized;
  }

  addTransaction(fixture: TransactionFixture, options: { finalized: boolean }): void {
    this.slot += 1;
    this.transactions.set(fixture.signature, {
      finalized: options.finalized,
      transaction: {
        signature: fixture.signature,
        slot: this.slot,
        blockTime: 1_760_000_000 + this.slot,
        error: fixture.error ?? null,
        instructions: fixture.instructions.map((instruction, index) => ({
          programId: instruction.programId.toBase58(),
          accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
          data: Uint8Array.from(instruction.data),
          inner: fixture.innerMissing === true ? null : (fixture.inner?.[index] ?? []),
        })),
      },
    });
  }

  /** Everything confirmed so far becomes finalized. */
  finalizeAll(): void {
    for (const entry of this.transactions.values()) entry.finalized = true;
    for (const entry of this.tasks.values()) entry.finalized = entry.confirmed;
  }

  dropTransaction(signature: string): void {
    this.transactions.delete(signature);
  }

  getTask(address: PublicKey, commitment: TaskraCommitment): Promise<TaskSnapshot | null> {
    this.guard('getAccountInfo');
    const entry = this.tasks.get(address.toBase58());
    const view = commitment === 'finalized' ? entry?.finalized : entry?.confirmed;
    return Promise.resolve(view == null ? null : { ...view, commitment });
  }

  getPlatform(): Promise<PlatformAccount> {
    this.guard('getAccountInfo');
    if (this.platform === null) throw new Error('fake platform not set');
    return Promise.resolve(this.platform);
  }

  getChainTime(): Promise<bigint> {
    this.guard('getAccountInfo');
    return Promise.resolve(BigInt(1_760_000_000 + this.slot));
  }

  getTransaction(
    signature: string,
    commitment: TaskraCommitment,
  ): Promise<ObservedTransaction | null> {
    this.guard('getTransaction');
    const entry = this.transactions.get(signature);
    if (entry === undefined || (commitment === 'finalized' && !entry.finalized)) {
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.transaction);
  }

  getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    this.guard('getSignatureStatuses');
    const entry = this.transactions.get(signature);
    if (entry === undefined) return Promise.resolve(null);
    return Promise.resolve({
      slot: entry.transaction.slot,
      finalized: entry.finalized,
      failed: entry.transaction.error !== null,
    });
  }

  findFinalizedSignatures(address: PublicKey, limit: number): Promise<string[]> {
    this.guard('getSignaturesForAddress');
    const target = address.toBase58();
    return Promise.resolve(
      [...this.transactions.values()]
        .filter(
          (entry) =>
            entry.finalized &&
            entry.transaction.instructions.some((instruction) =>
              instruction.accounts.includes(target),
            ),
        )
        .sort((left, right) => right.transaction.slot - left.transaction.slot)
        .slice(0, limit)
        .map((entry) => entry.transaction.signature),
    );
  }

  ping(): Promise<void> {
    this.guard('getSlot');
    return Promise.resolve();
  }
}
