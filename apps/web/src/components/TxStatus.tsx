'use client';

import { explorerUrl } from '../lib/env';
import type { TxState } from '../lib/transaction';
import { useApp } from '../state/app-context';

const LABELS: Record<TxState['phase'], string> = {
  building: 'Preparing the transaction…',
  awaiting_signature: 'Waiting for your wallet. Review and approve the transaction there.',
  submitted: 'Submitted. Waiting for the network to confirm it…',
  confirmed: 'Confirmed. Waiting for it to become final…',
  finalized: 'Final. The transaction is finalized on Solana.',
  failed: 'The transaction did not go through.',
};

/** Shows exactly the state it is given. Success is announced only for `finalized`. */
export function TxStatus({ state }: { readonly state: TxState | null }) {
  const { env } = useApp();
  if (state === null) return null;
  const signature = 'signature' in state ? state.signature : null;
  const tone =
    state.phase === 'failed' ? 'error' : state.phase === 'finalized' ? 'success' : 'pending';
  return (
    <div className={`tx tx-${tone}`} role="status" aria-live="polite" data-phase={state.phase}>
      <p className="tx-label">{LABELS[state.phase]}</p>
      {state.phase === 'failed' && <p>{state.failure.message}</p>}
      {state.phase === 'confirmed' && (
        <p className="muted">
          Confirmed is not final yet. Settlement is recorded only once the transaction is finalized.
        </p>
      )}
      {signature !== null && (
        <p>
          <a href={explorerUrl(env, 'tx', signature)} target="_blank" rel="noreferrer">
            View transaction {signature.slice(0, 8)}…
          </a>
        </p>
      )}
    </div>
  );
}
