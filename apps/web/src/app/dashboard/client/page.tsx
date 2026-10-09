'use client';

import Link from 'next/link';
import { TaskList } from '../../../components/TaskList';
import { useApp } from '../../../state/app-context';

export default function ClientDashboardPage() {
  const { address, signedIn } = useApp();
  if (address === null) {
    return (
      <>
        <h1>Client dashboard</h1>
        <p className="notice notice-warn">Connect a wallet to see the tasks you created.</p>
      </>
    );
  }
  return (
    <>
      <h1>Client dashboard</h1>
      <p>
        Tasks created by this wallet. <Link href="/tasks/new">Create a task</Link>
      </p>
      {!signedIn && <p className="muted">Sign in to also see your unfunded drafts.</p>}
      <TaskList
        key={`${address}:${String(signedIn)}`}
        filter={{ client: address }}
        empty="This wallet has not created any tasks yet."
      />
    </>
  );
}
