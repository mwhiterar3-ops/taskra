'use client';

import { TASK_STATES } from '@taskra/sdk';
import { useState } from 'react';
import { TaskList } from '../../components/TaskList';

export default function TasksPage() {
  const [state, setState] = useState('OPEN');
  return (
    <>
      <h1>Tasks</h1>
      <label style={{ maxWidth: '16rem' }}>
        State
        <select
          value={state}
          onChange={(event) => {
            setState(event.target.value);
          }}
        >
          <option value="">All</option>
          {TASK_STATES.map((name) => (
            <option key={name} value={name}>
              {name.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        This list comes from the Taskra API&apos;s last observation of each task. Open a task to
        read its current state from Solana.
      </p>
      <TaskList filter={state === '' ? {} : { state }} empty="No tasks in this state yet." />
    </>
  );
}
