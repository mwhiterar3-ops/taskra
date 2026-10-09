'use client';

import { PublicKey } from '@solana/web3.js';
import {
  fetchChainTime,
  fetchPlatform,
  fetchTask,
  type PlatformAccount,
  type TaskAccount,
  termsMatchTask,
} from '@taskra/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type TaskDetail } from '../lib/api';
import { useApp } from '../state/app-context';

export interface TaskData {
  /** Metadata, verification and history from the API. */
  readonly detail: TaskDetail | null;
  /**
   * The Task account read by this browser from Solana at `confirmed`. This,
   * not the API, is what the page shows as the task's state. `null` while no
   * account exists (a draft) or before the first read.
   */
  readonly account: TaskAccount | null;
  readonly platform: PlatformAccount | null;
  /** The cluster clock at the last read. */
  readonly chainTime: bigint | null;
  /** Whether the stored metadata hashes to the on-chain terms, checked here. */
  readonly termsVerified: boolean | null;
  readonly loading: boolean;
  readonly notFound: boolean;
  /** Set when the API or the RPC endpoint could not be read; older data stays on screen. */
  readonly problem: string | null;
  readonly refresh: () => void;
}

const POLL_MS = 5_000;

export function useTask(id: string): TaskData {
  const { api, connection, taskra } = useApp();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [account, setAccount] = useState<TaskAccount | null>(null);
  const [platform, setPlatform] = useState<PlatformAccount | null>(null);
  const [chainTime, setChainTime] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const address = useRef<string | null>(null);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Read through a function: the flag changes while a load is awaiting.
    const isLive = () => !cancelled;
    async function load() {
      const problems: string[] = [];
      try {
        const next = await api.task(id);
        if (!isLive()) return;
        setDetail(next);
        setNotFound(false);
        address.current = next.taskAddress;
      } catch (error) {
        if (!isLive()) return;
        if (error instanceof ApiError && error.status === 404) setNotFound(true);
        else problems.push('The Taskra API could not be reached; task details may be out of date.');
      }
      if (address.current !== null) {
        try {
          const [task, config, now] = await Promise.all([
            fetchTask(connection, taskra, new PublicKey(address.current), 'confirmed'),
            fetchPlatform(connection, taskra, 'confirmed'),
            fetchChainTime(connection, 'confirmed'),
          ]);
          if (!isLive()) return;
          setAccount(task);
          setPlatform(config);
          setChainTime(now);
        } catch {
          if (!isLive()) return;
          problems.push('Solana could not be read; the state shown may be out of date.');
        }
      }
      if (isLive()) {
        setProblem(problems.length === 0 ? null : problems.join(' '));
        setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, connection, taskra, id, tick]);

  const termsVerified =
    detail === null || account === null
      ? null
      : termsMatchTask(
          {
            repo: detail.repo,
            acceptanceCriteria: detail.acceptanceCriteria,
            workDuration: BigInt(detail.workDuration),
            amount: BigInt(detail.amount),
          },
          account,
        );

  return {
    detail,
    account,
    platform,
    chainTime,
    termsVerified,
    loading,
    notFound,
    problem,
    refresh,
  };
}
