/**
 * Persisted authorization epoch (#6827).
 *
 * Identity-binding changes must revoke pre-change authority everywhere, not
 * just on the instance that handled the mutation. Every binding mutation
 * bumps the epoch for the affected credentials inside its own transaction;
 * the auth middleware stamps the observed fingerprint onto its cache entries
 * and drops any entry whose fingerprint no longer matches.
 *
 * The fingerprint is compared for *inequality*, never ordering. Confirmed
 * deletion contributes its durable, non-cascading audit tombstone, so even an
 * epoch-0 credential moves from the empty fingerprint and cannot survive in a
 * different process's session/JWT cache after the users-row CASCADE.
 */

import type { Pool, PoolClient } from 'pg';
import { query } from './client.js';

/** Anything that can run a parameterized statement — pool or in-transaction client. */
type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface ActiveCredentialAuthorizationSnapshot {
  workos_user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  identity_id: string;
  primary_workos_user_id: string | null;
  fingerprint: string;
}

export type CredentialAuthorizationLifecycle =
  | { status: 'active'; snapshot: ActiveCredentialAuthorizationSnapshot }
  | {
      status: 'terminal';
      reason: 'deleted_or_quarantined' | 'missing_user' | 'missing_binding' | 'missing_primary';
    }
  | { status: 'unavailable' };

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
): Promise<string[]> {
  const ids = [...new Set(workosUserIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const bumped = await db.query<{ workos_user_id: string }>(
    `INSERT INTO authorization_epochs (workos_user_id, epoch)
     SELECT u.workos_user_id, 1 FROM users u WHERE u.workos_user_id = ANY($1)
     ON CONFLICT (workos_user_id) DO UPDATE
       SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()
     RETURNING workos_user_id`,
    [ids],
  );
  return bumped.rows.map((row) => row.workos_user_id);
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
    `WITH fingerprint_parts AS (
       SELECT ae.workos_user_id || ':epoch:' || ae.epoch AS part
         FROM authorization_epochs ae
        WHERE ae.workos_user_id = ANY($1)
       UNION ALL
       SELECT ral.workos_user_id ||
              CASE WHEN ral.action = 'identity_credential_admin_compensation_quarantined'
                   THEN ':quarantined:' ELSE ':deleted:' END || ral.id AS part
         FROM registry_audit_log ral
        WHERE ral.workos_user_id = ANY($1)
          AND ral.action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined',
            'identity_credential_admin_compensation_deleted', 'identity_credential_admin_compensation_quarantined')
     )
     SELECT string_agg(part, ',' ORDER BY part) AS fingerprint
       FROM fingerprint_parts`,
    [ids],
  );
  return result.rows[0]?.fingerprint ?? '';
}

/**
 * Authoritative positive-authentication snapshot for one real credential.
 *
 * A fingerprint alone is not proof that the credential is live: after
 * deletion the durable marker is itself a stable fingerprint. Positive auth
 * cache acceptance and writes must therefore read the local user, identity
 * binding, absence of the deletion tombstone, canonical route, and epoch in
 * one database statement. Missing/corrupt/deleted credentials are terminal;
 * database errors become an explicit unavailable state so callers fail closed.
 */
export async function readCredentialAuthorizationLifecycle(
  workosUserId: string,
): Promise<CredentialAuthorizationLifecycle> {
  try {
    const result = await query<ActiveCredentialAuthorizationSnapshot & {
      user_exists: boolean;
      binding_exists: boolean;
      primary_count: string;
      terminal_marker: boolean;
    }>(
      `WITH requested AS (
         SELECT $1::text AS workos_user_id
       )
       SELECT requested.workos_user_id,
              u.email,
              u.first_name,
              u.last_name,
              iwu.identity_id,
              primary_binding.workos_user_id AS primary_workos_user_id,
              CASE WHEN ae.workos_user_id IS NULL THEN ''
                   ELSE ae.workos_user_id || ':epoch:' || ae.epoch
               END AS fingerprint,
              (u.workos_user_id IS NOT NULL) AS user_exists,
              (iwu.workos_user_id IS NOT NULL) AS binding_exists,
              COALESCE(primary_binding.primary_count, 0)::text AS primary_count,
              EXISTS (
                SELECT 1
                  FROM registry_audit_log ral
                 WHERE ral.workos_user_id = requested.workos_user_id
                   AND ral.action IN (
                     'identity_credential_deleted',
                     'identity_primary_deletion_quarantined',
                     'identity_credential_admin_compensation_deleted',
                     'identity_credential_admin_compensation_quarantined'
                   )
              ) AS terminal_marker
         FROM requested
         LEFT JOIN users u
           ON u.workos_user_id = requested.workos_user_id
         LEFT JOIN identity_workos_users iwu
           ON iwu.workos_user_id = requested.workos_user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS primary_count,
                  MIN(candidate.workos_user_id) AS workos_user_id
             FROM identity_workos_users candidate
            WHERE candidate.identity_id = iwu.identity_id
              AND candidate.is_primary = TRUE
         ) primary_binding ON TRUE
         LEFT JOIN authorization_epochs ae
           ON ae.workos_user_id = requested.workos_user_id`,
      [workosUserId],
    );
    const row = result.rows[0];
    if (!row || row.terminal_marker) {
      return { status: 'terminal', reason: 'deleted_or_quarantined' };
    }
    if (!row.user_exists) return { status: 'terminal', reason: 'missing_user' };
    if (!row.binding_exists) return { status: 'terminal', reason: 'missing_binding' };
    if (Number(row.primary_count) !== 1 || !row.primary_workos_user_id) {
      return { status: 'terminal', reason: 'missing_primary' };
    }
    return {
      status: 'active',
      snapshot: {
        workos_user_id: row.workos_user_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        identity_id: row.identity_id,
        primary_workos_user_id: row.primary_workos_user_id,
        fingerprint: row.fingerprint,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
}
