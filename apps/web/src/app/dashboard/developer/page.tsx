'use client';

import Link from 'next/link';
import { TaskList } from '../../../components/TaskList';
import { useApp } from '../../../state/app-context';

export default function DeveloperDashboardPage() {
  const { address, githubLogin, signedIn } = useApp();
  if (address === null) {
    return (
      <>
        <h1>Developer dashboard</h1>
        <p className="notice notice-warn">Connect a wallet to see the tasks you accepted.</p>
      </>
    );
  }
  return (
    <>
      <h1>Developer dashboard</h1>
      {signedIn && githubLogin === null && (
        <p className="notice notice-warn">
          No GitHub identity is connected to this wallet, so your pull requests cannot be verified.
          Connect one on your <Link href={`/profile/${address}`}>profile</Link>.
        </p>
      )}
      <p>
        Tasks this wallet accepted. <Link href="/tasks">Browse open tasks</Link>
      </p>
      <TaskList
        filter={{ developer: address }}
        empty="This wallet has not accepted any tasks yet."
      />
    </>
  );
}
