import type { PoolClient } from 'pg';

/**
 * Canonical local-commit fence for exact WorkOS credentials.
 *
 * Every authorization writer uses the same deterministic row order and fails
 * closed on contention. The table lock covers a concurrent platform-ban
 * insert, for which there may not yet be a row to lock.
 */
export async function lockExactCredentialAuthorizationRows(
  db: Pick<PoolClient, 'query'>,
  workosUserIds: string[],
): Promise<void> {
  const ids = [...new Set(workosUserIds)].sort();
  await db.query(
    'SELECT workos_user_id FROM users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT',
    [ids],
  );
  await db.query(
    'SELECT workos_user_id FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT',
    [ids],
  );
  await db.query(
    'SELECT workos_user_id FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT',
    [ids],
  );
  await db.query('LOCK TABLE bans IN SHARE MODE NOWAIT');
}
