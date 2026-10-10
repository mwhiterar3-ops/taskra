'use client';

import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  acceptTask,
  approveTask,
  cancelTask,
  createAndFundTask,
  createUsdcAccountIdempotent,
  evidenceHash,
  evidenceTrailers,
  expireDispute,
  expireReview,
  fetchTokenAmount,
  findAssociatedTokenAddress,
  hasValidAttestation,
  openDeveloperDispute,
  refundExpired,
  rejectionReasonHash,
  rejectTask,
  resolveDispute,
  submitWork,
  taskIdFromUuid,
  termsHash,
  toHex,
} from '@taskra/sdk';
import { type SyntheticEvent, useState } from 'react';
import type { TaskData } from '../hooks/use-task';
import { useTransaction } from '../hooks/use-transaction';
import { type ActionKind, availableActions } from '../lib/actions';
import { formatUsdc } from '../lib/amounts';
import { useApp } from '../state/app-context';
import { TxStatus } from './TxStatus';

const LABELS: Record<ActionKind, string> = {
  cancel: 'Cancel task and refund escrow',
  accept: 'Accept task',
  submit: 'Submit evidence',
  approve: 'Approve and pay developer',
  reject: 'Reject submission',
  refund: 'Refund escrow',
  developer_dispute: 'Open dispute',
  expire_review: 'Settle: review window passed',
  resolve_dispute: 'Resolve dispute',
  expire_dispute: 'Close dispute: deadline passed',
};

const SHA = /^[0-9a-fA-F]{40}$/;

export function TaskActions({ data }: { readonly data: TaskData }) {
  const app = useApp();
  const tx = useTransaction(data.refresh);
  const [prNumber, setPrNumber] = useState('');
  const [headSha, setHeadSha] = useState('');
  const [lookup, setLookup] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const { detail, account, platform, chainTime } = data;
  const me = app.publicKey;

  if (detail === null) return null;
  if (me === null || app.address === null) {
    return <p className="muted">Connect a wallet to act on this task.</p>;
  }
  const task = new PublicKey(detail.taskAddress);
  const myAddress = app.address;
  const { taskra, api } = app;
  const disabled = tx.busy;

  /** Signs in if needed (once), then sends. Reporting needs the session. */
  async function send(
    instructions: readonly TransactionInstruction[],
    route: string,
    extra: Record<string, unknown> = {},
  ) {
    setFormError(null);
    if (!(await app.signIn())) return;
    await tx.run(instructions, (signature) =>
      api.report(detail?.id ?? '', route, { signature, ...extra }),
    );
  }
  const usdcAccount = (owner: PublicKey) =>
    createUsdcAccountIdempotent(taskra, { payer: me, owner });

  // --- DRAFT: nothing exists on-chain yet -----------------------------------
  if (account === null) {
    if (detail.clientWallet !== app.address) return null;
    const fund = async () => {
      const amount = BigInt(detail.amount);
      const workDuration = BigInt(detail.workDuration);
      // Recomputed here: the browser funds the terms it can see, not a hash it was handed.
      const hash = termsHash({
        repo: detail.repo,
        acceptanceCriteria: detail.acceptanceCriteria,
        workDuration,
        amount,
      });
      if (toHex(hash) !== detail.termsHash) {
        setFormError('The task terms do not match their hash. Do not fund this task.');
        return;
      }
      const balance = await fetchTokenAmount(
        app.connection,
        findAssociatedTokenAddress(me, taskra.usdcMint),
        'confirmed',
      ).catch(() => null);
      if (balance === null || balance < amount) {
        setFormError(
          `This wallet holds ${formatUsdc(balance ?? 0n)} USDC; the task needs ${formatUsdc(amount)} USDC.`,
        );
        return;
      }
      await send(
        [
          createAndFundTask(taskra, {
            client: me,
            taskId: taskIdFromUuid(detail.id),
            amount,
            workDuration,
            termsHash: hash,
          }),
        ],
        'fund',
      );
    };
    return (
      <section aria-labelledby="actions-title">
        <h2 id="actions-title">Fund escrow</h2>
        <p>
          This task is a draft. Funding creates it on Solana and moves{' '}
          <strong>{formatUsdc(detail.amount)} USDC</strong> from your wallet into escrow, in one
          transaction.
        </p>
        <button type="button" disabled={disabled} onClick={() => void fund()}>
          Create task and fund {formatUsdc(detail.amount)} USDC
        </button>
        {formError !== null && (
          <p className="notice notice-error" role="alert">
            {formError}
          </p>
        )}
        <TxStatus state={tx.state} />
      </section>
    );
  }

  if (platform === null || chainTime === null) return <p className="muted">Reading Solana…</p>;
  const actions = availableActions({
    task: account,
    chainTime,
    wallet: app.address,
    platformAuthority: platform.authority.toBase58(),
  });
  const client = account.client;
  const developer = account.developer;
  const parties =
    developer === null ? null : { task, client, developer, treasury: platform.treasury };

  function run(kind: ActionKind) {
    switch (kind) {
      case 'accept':
        return send([acceptTask(taskra, { developer: me as PublicKey, task })], 'accept');
      case 'cancel':
        return send([usdcAccount(client), cancelTask(taskra, { client, task })], 'transactions');
      case 'refund':
        return send([usdcAccount(client), refundExpired(taskra, { client, task })], 'transactions');
      case 'approve':
        if (parties === null) return;
        // The hash on screen is the hash approved: a resubmission in between fails on-chain.
        return send(
          [
            usdcAccount(parties.developer),
            approveTask(taskra, {
              ...parties,
              evidenceHash: account?.evidenceHash ?? new Uint8Array(32),
            }),
          ],
          'approve',
        );
      case 'developer_dispute':
        return send(
          [openDeveloperDispute(taskra, { developer: me as PublicKey, task })],
          'transactions',
        );
      case 'expire_review':
        if (parties === null) return;
        return send(
          [usdcAccount(parties.developer), expireReview(taskra, parties)],
          'transactions',
        );
      case 'expire_dispute': {
        if (account === null || parties === null) return;
        const paysDeveloper = hasValidAttestation(account);
        return send(
          [
            usdcAccount(paysDeveloper ? parties.developer : client),
            expireDispute(taskra, {
              task,
              client,
              expected: paysDeveloper
                ? {
                    outcome: 'PAY_DEVELOPER',
                    developer: parties.developer,
                    treasury: parties.treasury,
                  }
                : { outcome: 'REFUND_CLIENT' },
            }),
          ],
          'transactions',
        );
      }
      default:
        return;
    }
  }

  function resolve(outcome: 'PAY_DEVELOPER' | 'REFUND_CLIENT') {
    if (parties === null) return;
    return send(
      [
        usdcAccount(outcome === 'PAY_DEVELOPER' ? parties.developer : client),
        resolveDispute(taskra, {
          authority: me as PublicKey,
          task,
          client,
          resolution:
            outcome === 'PAY_DEVELOPER'
              ? { outcome, developer: parties.developer, treasury: parties.treasury }
              : { outcome },
        }),
      ],
      'transactions',
    );
  }

  async function lookUpHead() {
    setLookup('Asking GitHub…');
    try {
      const response = await fetch(
        `https://api.github.com/repos/${detail?.repo ?? ''}/pulls/${prNumber}`,
        { headers: { accept: 'application/vnd.github+json' } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { head?: { sha?: unknown }; merged?: unknown };
      const sha = body.head?.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('bad response');
      setHeadSha(sha);
      setLookup(
        body.merged === true
          ? 'Found. The pull request is merged.'
          : 'Found. The pull request is not merged yet, so it cannot be verified until it is.',
      );
    } catch {
      setLookup('GitHub could not be read. Paste the head commit SHA of the pull request.');
    }
  }

  function submitEvidence(event: SyntheticEvent) {
    event.preventDefault();
    if (!/^[1-9]\d{0,8}$/.test(prNumber) || !SHA.test(headSha)) {
      setFormError('Enter the pull request number and its 40-character head commit SHA.');
      return;
    }
    const hash = evidenceHash({
      repo: detail?.repo ?? '',
      prNumber: BigInt(prNumber),
      headSha,
    });
    void send(
      [submitWork(taskra, { developer: me as PublicKey, task, evidenceHash: hash })],
      'evidence',
      { prNumber: Number(prNumber) },
    );
  }

  function submitRejection(event: SyntheticEvent) {
    event.preventDefault();
    if (reason.trim() === '') {
      setFormError('Give a reason. Its hash is recorded on-chain and cannot be changed later.');
      return;
    }
    void send(
      [rejectTask(taskra, { client, task, reasonHash: rejectionReasonHash(reason) })],
      'reject',
      { reason },
    );
  }

  if (actions.length === 0) {
    return (
      <section aria-labelledby="actions-title">
        <h2 id="actions-title">Actions</h2>
        <p className="muted">There is nothing for this wallet to do on this task right now.</p>
        <TxStatus state={tx.state} />
      </section>
    );
  }

  return (
    <section aria-labelledby="actions-title">
      <h2 id="actions-title">Actions</h2>
      <ul className="actions">
        {actions.map((action) => (
          <li key={action.kind}>
            {action.kind === 'submit' && action.enabled ? (
              <form onSubmit={submitEvidence} className="form">
                <h3>{LABELS.submit}</h3>
                <p>
                  The final commit of your pull request must end with these two lines. They say
                  which task the work is for and which wallet is paid, and they cannot be added
                  after the pull request is merged.
                </p>
                <pre className="mono notice" data-testid="trailers">
                  {evidenceTrailers(detail.id, myAddress)}
                </pre>
                <label>
                  Pull request number in <span className="mono">{detail.repo}</span>
                  <input
                    inputMode="numeric"
                    value={prNumber}
                    onChange={(event) => {
                      setPrNumber(event.target.value.trim());
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || prNumber === ''}
                  onClick={() => void lookUpHead()}
                >
                  Look up head commit on GitHub
                </button>
                {lookup !== null && <p className="muted">{lookup}</p>}
                <label>
                  Head commit SHA
                  <input
                    className="mono"
                    value={headSha}
                    onChange={(event) => {
                      setHeadSha(event.target.value.trim());
                    }}
                  />
                </label>
                <button type="submit" disabled={disabled}>
                  Record evidence on-chain
                </button>
              </form>
            ) : action.kind === 'reject' && action.enabled ? (
              <form onSubmit={submitRejection} className="form">
                <h3>{LABELS.reject}</h3>
                <label>
                  Reason (moves the task to a dispute)
                  <textarea
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                    rows={3}
                  />
                </label>
                <button type="submit" className="danger" disabled={disabled}>
                  Reject and open dispute
                </button>
              </form>
            ) : action.kind === 'resolve_dispute' ? (
              <div className="row">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void resolve('PAY_DEVELOPER')}
                >
                  Resolve: pay developer
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void resolve('REFUND_CLIENT')}
                >
                  Resolve: refund client
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={disabled || !action.enabled}
                onClick={() => void run(action.kind)}
              >
                {LABELS[action.kind]}
              </button>
            )}
            {action.note !== null && <p className="muted">{action.note}</p>}
          </li>
        ))}
      </ul>
      {formError !== null && (
        <p className="notice notice-error" role="alert">
          {formError}
        </p>
      )}
      <TxStatus state={tx.state} />
    </section>
  );
}
