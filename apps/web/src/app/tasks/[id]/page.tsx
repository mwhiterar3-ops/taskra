'use client';

import { computeTimeline, hasValidAttestation, splitSettlement, toHex } from '@taskra/sdk';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { TaskActions } from '../../../components/TaskActions';
import { StateBadge } from '../../../components/TaskList';
import { useTask } from '../../../hooks/use-task';
import { formatDuration, formatTime, formatUsdc, shortAddress } from '../../../lib/amounts';
import type { VerificationEntry } from '../../../lib/api';
import { explorerUrl } from '../../../lib/env';
import { useApp } from '../../../state/app-context';

const TX_STATUS_TEXT = {
  CONFIRMED: 'Confirmed, not final yet',
  FINALIZED: 'Finalized',
  FAILED: 'Failed',
  DROPPED: 'Dropped: it never became final',
} as const;

const VERIFICATION_TEXT = {
  PENDING: 'Pending: not decided yet. It is retried automatically.',
  VERIFIED: 'Verified: every rule holds.',
  REJECTED: 'Not verified: at least one rule failed.',
} as const;

function Verification({ entry, current }: { entry: VerificationEntry; current: boolean }) {
  const { env } = useApp();
  return (
    <div>
      <h3>
        Submission {entry.submissionNonce} · pull request #{entry.prNumber}
        {!current && ' (superseded)'}
      </h3>
      <p>{VERIFICATION_TEXT[entry.status]}</p>
      {entry.result !== null && (
        <>
          <ul className="plain rules">
            {entry.result.rules.map((rule) => (
              <li
                key={rule.rule}
                className={rule.passed === true ? 'pass' : rule.passed === false ? 'fail' : 'muted'}
              >
                {rule.passed === true ? '✓' : rule.passed === false ? '✗' : '–'} {rule.rule}:{' '}
                {rule.reason}
              </li>
            ))}
          </ul>
          {entry.result.headSha !== null && (
            <p className="muted">
              Head <span className="mono">{entry.result.headSha.slice(0, 12)}</span>
              {entry.result.mergeCommitSha !== null && (
                <>
                  {' '}
                  · merge commit{' '}
                  <span className="mono">{entry.result.mergeCommitSha.slice(0, 12)}</span>
                </>
              )}
              {entry.result.prAuthor !== null && <> · author {entry.result.prAuthor}</>}
              {entry.result.mergedBy !== null && <> · merged by {entry.result.mergedBy}</>}
            </p>
          )}
        </>
      )}
      {entry.attestation !== null && (
        <p>
          On-chain attestation: <strong>{entry.attestation.status}</strong>
          {entry.attestation.signature !== null && (
            <>
              {' '}
              ·{' '}
              <a
                href={explorerUrl(env, 'tx', entry.attestation.signature)}
                target="_blank"
                rel="noreferrer"
              >
                transaction
              </a>
            </>
          )}
          {entry.attestation.error !== null && <> · {entry.attestation.error}</>}
        </p>
      )}
      <p className="muted">
        CI and test results are not checked. A verified pull request is evidence, not proof that the
        work is correct.
      </p>
    </div>
  );
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const app = useApp();
  const data = useTask(id);
  const { detail, account, platform, chainTime } = data;

  if (data.loading && detail === null) return <p className="muted">Loading task…</p>;
  if (data.notFound || detail === null) {
    return (
      <>
        <h1>Task not found</h1>
        <p>
          There is no such task, or it is a draft that belongs to another wallet.{' '}
          {data.problem ?? ''}
        </p>
        <Link href="/tasks">Back to tasks</Link>
      </>
    );
  }

  const state = account?.state ?? 'DRAFT';
  const split = account === null ? null : splitSettlement(account.amount, account.feeBps);
  const timeline =
    account === null || platform === null ? null : computeTimeline(account, platform);

  return (
    <>
      <div className="row spread">
        <h1>{detail.title}</h1>
        <StateBadge state={state} />
      </div>
      <p className="muted">
        State read from Solana by this browser at <strong>confirmed</strong> commitment
        {chainTime !== null && <> · chain time {formatTime(chainTime)}</>}. Recent changes are final
        only once finalized.
      </p>
      {data.problem !== null && (
        <p className="notice notice-warn" role="alert">
          {data.problem}
        </p>
      )}
      {data.termsVerified === false && (
        <p className="notice notice-error" role="alert">
          The description below does not match the terms hash recorded on-chain. Treat it as
          unverified: do not rely on it, and do not approve work based on it.
        </p>
      )}

      <section aria-labelledby="terms-title">
        <h2 id="terms-title">
          Terms{' '}
          {data.termsVerified === true && <span className="pass">· match the on-chain hash</span>}
        </h2>
        {detail.description !== '' && <pre>{detail.description}</pre>}
        <dl className="facts">
          <dt>Repository</dt>
          <dd className="mono">{detail.repo}</dd>
          <dt>Acceptance criteria</dt>
          <dd>
            <pre>{detail.acceptanceCriteria}</pre>
          </dd>
          <dt>Time to deliver</dt>
          <dd>{formatDuration(detail.workDuration)} after acceptance</dd>
          <dt>Client</dt>
          <dd>
            <Link href={`/profile/${detail.clientWallet}`} className="mono">
              {shortAddress(detail.clientWallet)}
            </Link>
          </dd>
          {account?.developer != null && (
            <>
              <dt>Developer</dt>
              <dd>
                <Link href={`/profile/${account.developer.toBase58()}`} className="mono">
                  {shortAddress(account.developer.toBase58())}
                </Link>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="escrow-title">
        <h2 id="escrow-title">Escrow</h2>
        {account === null || split === null ? (
          <p>
            Draft: nothing is on-chain and no funds are held. Reward when funded:{' '}
            <strong>{formatUsdc(detail.amount)} USDC</strong>.
          </p>
        ) : (
          <dl className="facts">
            <dt>Amount in the task</dt>
            <dd>
              <strong>{formatUsdc(account.amount)} USDC</strong>
            </dd>
            <dt>If settled</dt>
            <dd>
              Developer {formatUsdc(split.developerAmount)} USDC · treasury {formatUsdc(split.fee)}{' '}
              USDC ({(account.feeBps / 100).toString()}%)
            </dd>
            <dt>If refunded</dt>
            <dd>Client {formatUsdc(account.amount)} USDC, no fee</dd>
            <dt>Task account</dt>
            <dd>
              <a
                href={explorerUrl(app.env, 'address', detail.taskAddress)}
                target="_blank"
                rel="noreferrer"
              >
                <span className="mono">{shortAddress(detail.taskAddress)}</span>
              </a>
            </dd>
            {account.outcome !== 'NONE' && (
              <>
                <dt>Outcome</dt>
                <dd>{account.outcome.replaceAll('_', ' ')}</dd>
              </>
            )}
          </dl>
        )}
        {detail.settlement !== null && (
          <div className="tx tx-success">
            <p className="tx-label">
              Finalized: {detail.settlement.outcome.replaceAll('_', ' ').toLowerCase()}
            </p>
            <p>
              Developer received {formatUsdc(detail.settlement.developerAmount)} USDC · treasury{' '}
              {formatUsdc(detail.settlement.feeAmount)} USDC · client{' '}
              {formatUsdc(detail.settlement.clientAmount)} USDC
            </p>
            <p>
              <a
                href={explorerUrl(app.env, 'tx', detail.settlement.signature)}
                target="_blank"
                rel="noreferrer"
              >
                View the settlement transaction
              </a>
            </p>
          </div>
        )}
        {account !== null &&
          ['SETTLED', 'REFUNDED', 'CANCELLED'].includes(account.state) &&
          detail.settlement === null && (
            <p className="notice notice-warn">
              The task shows {account.state} at confirmed commitment. It is recorded as settled only
              once that is finalized.
            </p>
          )}
      </section>

      {timeline !== null && account !== null && (
        <section aria-labelledby="timeline-title">
          <h2 id="timeline-title">Deadlines</h2>
          <dl className="facts">
            <dt>Work deadline</dt>
            <dd>{formatTime(timeline.workDeadline)}</dd>
            <dt>Verification deadline</dt>
            <dd>{formatTime(timeline.verificationDeadline)}</dd>
            {timeline.reviewDeadline !== null && (
              <>
                <dt>Review deadline</dt>
                <dd>{formatTime(timeline.reviewDeadline)}</dd>
              </>
            )}
            {timeline.developerDisputeWindow !== null && account.state === 'SUBMITTED' && (
              <>
                <dt>Developer may dispute</dt>
                <dd>
                  after {formatTime(timeline.developerDisputeWindow.opensAfter)} until{' '}
                  {formatTime(timeline.developerDisputeWindow.closesAt)}
                </dd>
              </>
            )}
            {timeline.disputeDeadline !== null && (
              <>
                <dt>Dispute deadline</dt>
                <dd>{formatTime(timeline.disputeDeadline)}</dd>
              </>
            )}
            {timeline.latestClientRecoveryAt !== null && (
              <>
                <dt>Latest possible refund</dt>
                <dd>
                  {formatTime(timeline.latestClientRecoveryAt)} (worst case, if nobody else acts)
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      <TaskActions data={data} />

      {account !== null && account.submissionNonce !== 0n && (
        <section aria-labelledby="evidence-title">
          <h2 id="evidence-title">Evidence and verification</h2>
          <p>
            Current submission {account.submissionNonce.toString()} · evidence hash{' '}
            <span className="mono">{toHex(account.evidenceHash).slice(0, 16)}…</span> ·{' '}
            {hasValidAttestation(account) ? (
              <strong className="pass">verified on-chain</strong>
            ) : (
              <strong>not verified on-chain</strong>
            )}
          </p>
          {detail.verification.length === 0 ? (
            <p className="muted">
              The developer has not registered a pull request for this submission with Taskra, so it
              cannot be verified yet.
            </p>
          ) : (
            detail.verification.map((entry) => (
              <Verification
                key={entry.submissionNonce}
                entry={entry}
                current={entry.submissionNonce === account.submissionNonce.toString()}
              />
            ))
          )}
          {detail.rejection !== null && (
            <div className="notice notice-error">
              <p className="tx-label">Rejected by the client</p>
              <pre>{detail.rejection.reason}</pre>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="history-title">
        <h2 id="history-title">Transactions</h2>
        {detail.transactions.length === 0 ? (
          <p className="muted">No transactions have been observed for this task yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Instruction</th>
                <th scope="col">Status</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {detail.transactions.map((entry) => (
                <tr key={entry.signature}>
                  <td className="mono">{entry.instruction}</td>
                  <td>
                    {TX_STATUS_TEXT[entry.status]}
                    {entry.error !== null && ` (${entry.error})`}
                  </td>
                  <td>
                    <a
                      href={explorerUrl(app.env, 'tx', entry.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="mono">{entry.signature.slice(0, 10)}…</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
