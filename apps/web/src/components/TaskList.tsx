'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatDuration, formatUsdc, shortAddress } from '../lib/amounts';
import type { TaskSummary } from '../lib/api';
import { useApp } from '../state/app-context';

export function StateBadge({ state }: { readonly state: string }) {
  return <span className={`badge badge-${state.toLowerCase()}`}>{state.replaceAll('_', ' ')}</span>;
}

export interface TaskListProps {
  readonly filter: { state?: string; client?: string; developer?: string };
  readonly empty: string;
}

/**
 * A list served from the API's cache. Each row says so: the task page itself
 * always reads the current state from Solana.
 */
export function TaskList({ filter, empty }: TaskListProps) {
  const { api } = useApp();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(filter);

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    setFailed(false);
    api
      .listTasks(JSON.parse(key) as TaskListProps['filter'])
      .then((result) => {
        if (!cancelled) setTasks(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, key]);

  if (failed) {
    return (
      <p className="notice notice-error" role="alert">
        The task list could not be loaded. Check that the Taskra API is running.
      </p>
    );
  }
  if (tasks === null) return <p className="muted">Loading tasks…</p>;
  if (tasks.length === 0) return <p className="muted">{empty}</p>;

  return (
    <ul className="cards">
      {tasks.map((task) => (
        <li key={task.id} className="card">
          <div className="row spread">
            <Link href={`/tasks/${task.id}`} className="card-title">
              {task.title}
            </Link>
            <StateBadge state={task.state} />
          </div>
          <p>
            <strong>{formatUsdc(task.amount)} USDC</strong> · {formatDuration(task.workDuration)} to
            deliver · <span className="mono">{task.repo}</span>
          </p>
          <p className="muted">
            Client <span className="mono">{shortAddress(task.clientWallet)}</span>
            {task.developerWallet !== null && (
              <>
                {' '}
                · Developer <span className="mono">{shortAddress(task.developerWallet)}</span>
              </>
            )}
            {task.termsVerified === false && ' · terms do not match the chain'}
          </p>
        </li>
      ))}
    </ul>
  );
}
