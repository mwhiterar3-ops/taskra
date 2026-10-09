'use client';

import type { TransactionInstruction } from '@solana/web3.js';
import { useCallback, useRef, useState } from 'react';
import { runTransaction, type TxState } from '../lib/transaction';
import { useApp } from '../state/app-context';

export interface UseTransaction {
  readonly state: TxState | null;
  /** True from the first click until the transaction is finalized or has failed. */
  readonly busy: boolean;
  /**
   * Sends one transaction. A second call while one is in flight is ignored, so
   * a double click can never send twice. `report` tells the API about the
   * signature once it is confirmed.
   */
  run(
    instructions: readonly TransactionInstruction[],
    report?: (signature: string) => Promise<unknown>,
  ): Promise<TxState | null>;
  reset(): void;
}

export function useTransaction(onSettled?: () => void): UseTransaction {
  const { connection, wallet, publicKey } = useApp();
  const [state, setState] = useState<TxState | null>(null);
  const inFlight = useRef(false);

  const run = useCallback<UseTransaction['run']>(
    async (instructions, report) => {
      if (inFlight.current || wallet === null || publicKey === null) return null;
      inFlight.current = true;
      try {
        const final = await runTransaction({
          rpc: connection,
          wallet,
          feePayer: publicKey,
          instructions,
          onState: setState,
          ...(report === undefined
            ? {}
            : {
                onConfirmed: async (signature: string) => {
                  await report(signature);
                  onSettled?.();
                },
              }),
        });
        return final;
      } finally {
        inFlight.current = false;
        // Whatever happened, show what the chain says now.
        onSettled?.();
      }
    },
    [connection, wallet, publicKey, onSettled],
  );

  const busy = state !== null && state.phase !== 'finalized' && state.phase !== 'failed';
  return {
    state,
    busy,
    run,
    reset: () => {
      setState(null);
    },
  };
}
