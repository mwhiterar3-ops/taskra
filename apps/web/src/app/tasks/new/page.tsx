'use client';

import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useState } from 'react';
import { formatUsdc, parseHours, parseUsdc } from '../../../lib/amounts';
import { ApiError } from '../../../lib/api';
import { useApp } from '../../../state/app-context';

const FEE_BPS = 250n;

export default function NewTaskPage() {
  const app = useApp();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState('');
  const [criteria, setCriteria] = useState('');
  const [reward, setReward] = useState('');
  const [hours, setHours] = useState('48');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amount = parseUsdc(reward);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setError(null);
    const workDuration = parseHours(hours);
    if (amount === null) {
      setError('Enter the reward in USDC, for example 100 or 49.50.');
      return;
    }
    if (workDuration === null) {
      setError('Enter the time to deliver as a whole number of hours (1 to 8760).');
      return;
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo.trim())) {
      setError('Enter the repository as owner/name, for example octo-org/parser.');
      return;
    }
    if (title.trim() === '' || criteria.trim() === '') {
      setError('A title and acceptance criteria are required.');
      return;
    }
    setSaving(true);
    try {
      if (!(await app.signIn())) return;
      const draft = await app.api.createDraft({
        title: title.trim(),
        description,
        repo: repo.trim(),
        acceptanceCriteria: criteria,
        workDuration: workDuration.toString(),
        amount: amount.toString(),
      });
      // Nothing is on-chain yet. The task page funds it.
      router.push(`/tasks/${draft.id}`);
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'The draft could not be saved. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>Create a task</h1>
      <p className="muted">
        Step 1 of 2. This saves a draft. No funds move until you fund the escrow on the next page.
        The repository, criteria, time and reward are fixed by a hash once funded and cannot be
        edited afterwards.
      </p>
      {app.address === null && (
        <p className="notice notice-warn">Connect a wallet to create a task.</p>
      )}
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label>
          Title
          <input
            value={title}
            maxLength={200}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            value={description}
            maxLength={10000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
        <label>
          Target repository
          <span className="hint">
            owner/name on GitHub. It must be public and already exist. The work is a pull request
            merged into it by someone other than its author.
          </span>
          <input
            className="mono"
            value={repo}
            placeholder="octo-org/parser"
            onChange={(event) => {
              setRepo(event.target.value);
            }}
          />
        </label>
        <label>
          Acceptance criteria
          <span className="hint">Objective deliverables, one per line.</span>
          <textarea
            rows={5}
            value={criteria}
            maxLength={10000}
            onChange={(event) => {
              setCriteria(event.target.value);
            }}
          />
        </label>
        <label>
          Reward (USDC)
          <input
            inputMode="decimal"
            value={reward}
            placeholder="100"
            onChange={(event) => {
              setReward(event.target.value);
            }}
          />
        </label>
        {amount !== null && (
          <p className="muted">
            On settlement the developer receives {formatUsdc(amount - (amount * FEE_BPS) / 10_000n)}{' '}
            USDC and the Taskra treasury {formatUsdc((amount * FEE_BPS) / 10_000n)} USDC (2.5%). A
            refund or cancellation returns the full {formatUsdc(amount)} USDC. The fee actually
            charged is the one configured on-chain.
          </p>
        )}
        <label>
          Time to deliver after acceptance (hours)
          <input
            inputMode="numeric"
            value={hours}
            onChange={(event) => {
              setHours(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={saving || app.address === null}>
          {saving ? 'Saving draft…' : 'Save draft and continue'}
        </button>
        {error !== null && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
