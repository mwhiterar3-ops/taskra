'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatUsdc } from '../../../lib/amounts';
import type { Reputation } from '../../../lib/api';
import { explorerUrl } from '../../../lib/env';
import { useApp } from '../../../state/app-context';

const GITHUB_RESULT: Record<string, string> = {
  linked: 'Your GitHub identity is now connected to this wallet.',
  state_invalid: 'The GitHub sign-in could not be matched to this browser. Start again.',
  exchange_failed: 'GitHub did not complete the sign-in. Start again.',
  already_linked: 'That GitHub account is already connected to another wallet.',
};

function Profile() {
  const { wallet } = useParams<{ wallet: string }>();
  const result = useSearchParams().get('github');
  const app = useApp();
  const { api, refreshSession } = app;
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [github, setGithub] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const own = app.address === wallet;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.reputation(wallet), api.user(wallet)])
      .then(([rep, user]) => {
        if (cancelled) return;
        setReputation(rep);
        setGithub(user.github?.login ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    if (result === 'linked') void refreshSession();
    return () => {
      cancelled = true;
    };
  }, [api, wallet, result, refreshSession]);

  if (failed) {
    return (
      <p className="notice notice-error" role="alert">
        This profile could not be loaded. Check the address and that the Taskra API is running.
      </p>
    );
  }
  if (reputation === null) return <p className="muted">Loading profile…</p>;
  const { developer, client, reliableContributor } = reputation;
  const finished = developer.tasksSettled + developer.tasksRefunded;

  return (
    <>
      <h1>
        Profile{' '}
        <span className="mono">
          {wallet.slice(0, 4)}…{wallet.slice(-4)}
        </span>
      </h1>
      {result !== null && GITHUB_RESULT[result] !== undefined && (
        <p className={`notice ${result === 'linked' ? '' : 'notice-error'}`} role="status">
          {GITHUB_RESULT[result]}
        </p>
      )}

      <section aria-labelledby="github-title">
        <h2 id="github-title">GitHub identity</h2>
        <p>{github === null ? 'No GitHub identity is connected.' : `Connected as ${github}.`}</p>
        {own &&
          (app.signedIn ? (
            // A full-page navigation: the API redirects to GitHub and back here.
            <a href={`${api.baseUrl}/api/v1/github/connect`}>
              {github === null ? 'Connect GitHub' : 'Connect a different GitHub account'}
            </a>
          ) : (
            <button type="button" onClick={() => void app.signIn()}>
              Sign in to connect GitHub
            </button>
          ))}
        <p className="muted">
          Taskra asks GitHub only who you are. A pull request counts as your evidence only if this
          account is its author.
        </p>
      </section>

      <section aria-labelledby="dev-title">
        <h2 id="dev-title">As a developer</h2>
        <p className="muted">
          Off-chain aggregate of finalized on-chain settlements. Wallets are not identities:
          distinct clients are an imperfect signal.
        </p>
        <dl className="facts">
          <dt>Tasks settled</dt>
          <dd>{developer.tasksSettled}</dd>
          <dt>Settled of finished</dt>
          <dd>
            {finished === 0 ? '—' : `${String(developer.tasksSettled)} of ${String(finished)}`}
          </dd>
          <dt>Total earned</dt>
          <dd>{formatUsdc(developer.totalEarned)} USDC</dd>
          <dt>Distinct clients</dt>
          <dd>{developer.distinctClients}</dd>
          <dt>Disputed tasks</dt>
          <dd>{developer.tasksDisputed}</dd>
          <dt>Refunded tasks</dt>
          <dd>{developer.tasksRefunded}</dd>
          <dt>Reliable Contributor</dt>
          <dd>
            {reliableContributor.qualified ? 'Reached' : 'Not reached'} (
            {reliableContributor.requirement.settledTasks} settled tasks from{' '}
            {reliableContributor.requirement.distinctClients} distinct clients) ·{' '}
            <strong>{reliableContributor.label}</strong>; no on-chain reward is attached.
          </dd>
        </dl>
        <h3>Verified work</h3>
        {reputation.verifiedWork.length === 0 ? (
          <p className="muted">No settled tasks yet.</p>
        ) : (
          <ul className="plain">
            {reputation.verifiedWork.map((work) => (
              <li key={work.taskId}>
                <Link href={`/tasks/${work.taskId}`}>{work.title}</Link> ·{' '}
                {formatUsdc(work.developerAmount)} USDC · <span className="mono">{work.repo}</span>{' '}
                ·{' '}
                <a
                  href={explorerUrl(app.env, 'tx', work.signature)}
                  target="_blank"
                  rel="noreferrer"
                >
                  settlement
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="client-title">
        <h2 id="client-title">As a client</h2>
        <dl className="facts">
          <dt>Tasks paid</dt>
          <dd>{client.tasksSettled}</dd>
          <dt>Total paid</dt>
          <dd>{formatUsdc(client.totalPaid)} USDC</dd>
          <dt>Distinct developers</dt>
          <dd>{client.distinctDevelopers}</dd>
          <dt>Refunded / cancelled</dt>
          <dd>
            {client.tasksRefunded} / {client.tasksCancelled}
          </dd>
          <dt>Disputed tasks</dt>
          <dd>{client.tasksDisputed}</dd>
        </dl>
      </section>
    </>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={<p className="muted">Loading profile…</p>}>
      <Profile />
    </Suspense>
  );
}
