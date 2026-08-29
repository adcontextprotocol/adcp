/**
 * Persisted authorization epoch (#6827).
 *
 * Identity-binding changes must revoke pre-change authority everywhere, not
 * just on the instance that handled the mutation. Every binding mutation
 * bumps the epoch for the affected credentials inside its own transaction;
 * the auth middleware stamps the observed fingerprint onto its cache entries
 * and drops any entry whose fingerprint no longer matches.
 *
 * The fingerprint is compared for *inequality*, never ordering: a CASCADE
 * delete (WorkOS `user.deleted`) removes a row, which moves the fingerprint
 * backwards and must still invalidate.
 */

import type { Pool, PoolClient } from 'pg';
import { query } from './client.js';

/** Anything that can run a parameterized statement — pool or in-transaction client. */
type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Bump the authorization epoch for each credential, in the caller's
 * transaction. Call this in the same transaction as the binding mutation:
 * a bump that commits separately leaves a window where the binding changed
 * but stale sessions still validate.
 *
 * Credentials with no `users` row are skipped rather than erroring, so this
 * is safe to call alongside a deletion (the CASCADE removes the row anyway,
 * and its absence is itself a fingerprint change).
 */
export async function bumpAuthorizationEpochs(
  db: Queryable,
  workosUserIds: string[],
): Promise<void> {
  const ids = [...new Set(workosUserIds.filter(Boolean))];
  if (ids.length === 0) return;

  await db.query(
    `INSERT INTO authorization_epochs (workos_user_id, epoch)
     SELECT u.workos_user_id, 1 FROM users u WHERE u.workos_user_id = ANY($1)
     ON CONFLICT (workos_user_id) DO UPDATE
       SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()`,
    [ids],
  );
}

/**
 * Read the current authorization fingerprint for a credential set. Empty
 * string when none of them has ever been bumped.
 *
 * ponytail: one primary-key read per cached request. If it shows up in p99,
 * replace with a LISTEN/NOTIFY invalidation channel rather than a TTL cache —
 * a cache in front of this would reintroduce exactly the staleness the epoch
 * exists to remove.
 */
export async function getAuthorizationFingerprint(
  workosUserIds: string[],
): Promise<string> {
  const ids = [...new Set(workosUserIds.filter(Boolean))];
  if (ids.length === 0) return '';

  const result = await query<{ fingerprint: string | null }>(
    `SELECT string_agg(workos_user_id || ':' || epoch, ',' ORDER BY workos_user_id)
              AS fingerprint
       FROM authorization_epochs
      WHERE workos_user_id = ANY($1)`,
    [ids],
  );
  return result.rows[0]?.fingerprint ?? '';
}
