import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { walletSchema } from '../validation.js';

const walletParams = z.object({ wallet: walletSchema });

/**
 * The Reliable Contributor milestone (docs/01-PRODUCT-SPEC.md §17, amended):
 * computed off-chain from finalized settlements. No reward is attached to it.
 */
export const RELIABLE_CONTRIBUTOR = { settledTasks: 3, distinctClients: 3 } as const;

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool } = deps;

  app.get('/api/v1/users/:wallet', async (request) => {
    const { wallet } = walletParams.parse(request.params);
    const result = await pool.query<{ created_at: Date; login: string | null }>(
      `SELECT w.created_at, g.login
         FROM wallets w LEFT JOIN github_accounts g ON g.wallet = w.address
        WHERE w.address = $1`,
      [wallet],
    );
    const row = result.rows[0];
    return {
      wallet,
      /** Whether this wallet has ever signed in. Reputation exists either way. */
      registered: row !== undefined,
      github: row?.login == null ? null : { login: row.login },
    };
  });

  app.get('/api/v1/users/:wallet/reputation', async (request) => {
    const { wallet } = walletParams.parse(request.params);
    const developer = await pool.query<{
      tasks_settled: string;
      tasks_refunded: string;
      tasks_disputed: string;
      distinct_clients: string;
      total_earned: string;
    }>(`SELECT * FROM developer_reputation WHERE wallet = $1`, [wallet]);
    const client = await pool.query<{
      tasks_settled: string;
      tasks_refunded: string;
      tasks_cancelled: string;
      tasks_disputed: string;
      distinct_developers: string;
      total_paid: string;
    }>(`SELECT * FROM client_reputation WHERE wallet = $1`, [wallet]);
    const work = await pool.query<{
      task_id: string;
      title: string;
      repo: string;
      developer_amount: string;
      signature: string;
      closed_at: Date;
    }>(
      `SELECT s.task_id, t.title, t.repo, s.developer_amount, s.signature, s.closed_at
         FROM settlements s JOIN tasks t ON t.id = s.task_id
        WHERE s.developer_wallet = $1 AND s.state = 'SETTLED'
        ORDER BY s.closed_at DESC LIMIT 20`,
      [wallet],
    );

    const dev = developer.rows[0];
    const cli = client.rows[0];
    const settled = Number(dev?.tasks_settled ?? 0);
    const distinctClients = Number(dev?.distinct_clients ?? 0);
    return {
      wallet,
      /** Every figure below is derived from settlements observed at this commitment. */
      basis: { commitment: 'finalized', kind: 'Off-chain aggregate' },
      developer: {
        tasksSettled: settled,
        tasksRefunded: Number(dev?.tasks_refunded ?? 0),
        tasksDisputed: Number(dev?.tasks_disputed ?? 0),
        distinctClients,
        totalEarned: dev?.total_earned ?? '0',
      },
      client: {
        tasksSettled: Number(cli?.tasks_settled ?? 0),
        tasksRefunded: Number(cli?.tasks_refunded ?? 0),
        tasksCancelled: Number(cli?.tasks_cancelled ?? 0),
        tasksDisputed: Number(cli?.tasks_disputed ?? 0),
        distinctDevelopers: Number(cli?.distinct_developers ?? 0),
        totalPaid: cli?.total_paid ?? '0',
      },
      reliableContributor: {
        label: 'Off-chain aggregate',
        qualified:
          settled >= RELIABLE_CONTRIBUTOR.settledTasks &&
          distinctClients >= RELIABLE_CONTRIBUTOR.distinctClients,
        requirement: RELIABLE_CONTRIBUTOR,
      },
      verifiedWork: work.rows.map((row) => ({
        taskId: row.task_id,
        title: row.title,
        repo: row.repo,
        developerAmount: row.developer_amount,
        signature: row.signature,
        closedAt: row.closed_at.toISOString(),
      })),
    };
  });
}
