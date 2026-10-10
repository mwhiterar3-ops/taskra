import type { Queryable } from '@taskra/shared/db';

/**
 * Throws unless the login this process connected with can act as the API role
 * and nothing more.
 *
 * `SET ROLE taskra_api` on every connection is a habit of this code, not a
 * boundary: whoever takes over the process can run `SET ROLE NONE`. What they
 * can do then is decided by the login. A login that is a superuser, owns the
 * tables, or is a member of `taskra_attester` can write a VERIFIED result and
 * an attestation record, and the attestation service signs for the records it
 * finds. So on a deployment the API refuses to run with such a login, the same
 * way it refuses to run with the attester key in its environment
 * (docs/04-DATABASE-SPEC.md §6).
 *
 * The named cases are checked for the sake of the message. What decides is the
 * last check: no role this login is, or can become, may write a verification
 * result or an attestation record, however it came by the privilege (a direct
 * grant, `pg_write_all_data`, ownership, a role nobody thought of).
 *
 * Anything that keeps the question from being answered (no connection, no
 * schema) is a refusal too: the caller treats every throw the same way.
 */
export async function assertConfinedDatabaseLogin(db: Queryable): Promise<void> {
  const result = await db.query<{
    superuser: boolean;
    createrole: boolean;
    attester: boolean;
    owner: boolean;
    writes: boolean;
  }>(
    `SELECT r.rolsuper AS superuser,
            r.rolcreaterole AS createrole,
            pg_has_role(session_user, 'taskra_attester', 'MEMBER') AS attester,
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relkind = 'r'
                       AND pg_has_role(session_user, c.relowner, 'MEMBER')) AS owner,
            EXISTS (SELECT 1 FROM pg_roles m
                     WHERE pg_has_role(session_user, m.oid, 'MEMBER')
                       AND (has_table_privilege(m.oid, 'public.verification_results', 'INSERT')
                            OR has_table_privilege(m.oid, 'public.attestations', 'INSERT')
                            OR has_table_privilege(m.oid, 'public.attestations', 'UPDATE')))
              AS writes
       FROM pg_roles r WHERE r.rolname = session_user`,
  );
  const login = result.rows[0];
  if (login === undefined) throw new Error('could not inspect the database login');
  const excess = [
    login.superuser ? 'is a superuser' : null,
    login.createrole ? 'can create and alter roles' : null,
    login.owner ? 'owns tables of the schema (it is the migration login)' : null,
    login.attester ? 'is a member of taskra_attester' : null,
  ].filter((reason) => reason !== null);
  if (excess.length === 0 && login.writes) {
    excess.push('can write verification results or attestation records');
  }
  if (excess.length > 0) {
    throw new Error(
      `DATABASE_URL names a login that ${excess.join(', and ')}. On a deployment the API must ` +
        'connect with its own login, a member of taskra_api only: ' +
        'CREATE ROLE <name> LOGIN PASSWORD <secret> IN ROLE taskra_api',
    );
  }
}
