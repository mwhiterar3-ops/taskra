import pg from 'pg';

/** The two database roles of docs/04-DATABASE-SPEC.md §6. */
export type DatabaseRole = 'taskra_api' | 'taskra_attester';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * A pool whose every connection has dropped to `role`, so a service can write
 * only what its role is granted even when its login could do more.
 */
export function createPool(databaseUrl: string, role: DatabaseRole): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    // `role` is one of two literals above, never input.
    options: `-c role=${role}`,
  });
  // An idle client that errors must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/** Runs `work` in one transaction: commits if it resolves, rolls back if it throws. */
export async function withTransaction<Result>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** True for a PostgreSQL unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
