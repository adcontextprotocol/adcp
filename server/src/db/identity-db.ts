/**
 * Identity-binding operations for `identity_workos_users`.
 *
 * An "identity" is the person; a WorkOS user is one credential bundle for
 * one email. `identity_workos_users` rows bind credentials to identities,
 * with a partial unique index enforcing exactly one primary per identity.
 *
 * Extracted from the webhook handler so the SQL can be exercised by
 * integration tests against a real PostgreSQL instance without dragging in
 * the full webhook transitive dependency chain.
 */

import { getPool } from './client.js';
import { createLogger } from '../logger.js';
import { notifySystemError } from '../addie/error-notifier.js';

const logger = createLogger('identity-db');

/**
 * When a WorkOS user that is the primary binding on a multi-credential
 * identity is deleted (operator action, account closure, GDPR/CCPA erasure
 * webhook), the CASCADE on `identity_workos_users.workos_user_id` drops the
 * binding. The identity is left with zero primaries until an admin
 * intervenes — `attachIdentityId` resolves `primary_workos_user_id` to NULL
 * and skips the id-swap, so the surviving secondary signs in to an empty
 * workspace (all their app-state was keyed on the now-deleted primary's
 * workos_user_id). That's a denial-of-service against any non-primary user.
 *
 * Promote the longest-bound surviving secondary to primary in the same
 * transaction, before the CASCADE fires. The id-swap in the auth middleware
 * then routes both the dead binding and the surviving secondary to the new
 * primary, keeping app-state reads intact.
 *
 * Returns the promoted credential's workos_user_id when a promotion ran, or
 * null when there was no successor (single-credential identity — normal
 * deletion, nothing to do) or the deleted user was not primary.
 *
 * On unexpected DB errors: log + ops alert, return null. The caller still
 * returns 200 to WorkOS so the webhook doesn't retry-storm on a transient
 * promotion failure; the binding is still deleted by the subsequent CASCADE,
 * and admins can repair the identity manually.
 */
export async function promoteSecondaryIfPrimaryDeleted(
  workosUserId: string,
): Promise<{ promotedUserId: string } | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the binding row to serialize concurrent promotions (e.g. two
    // user.deleted webhooks against bindings on the same identity).
    const primaryCheck = await client.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id = $1 AND is_primary = TRUE
        FOR UPDATE`,
      [workosUserId],
    );

    if (primaryCheck.rows.length === 0) {
      // Not primary (or no binding at all) — nothing to promote.
      await client.query('ROLLBACK');
      return null;
    }

    const identityId = primaryCheck.rows[0].identity_id;

    // Pick the longest-bound surviving secondary — matches the
    // findSuccessorForPromotion convention used by membership owner
    // succession (created_at ASC).
    const successor = await client.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM identity_workos_users
        WHERE identity_id = $1
          AND workos_user_id <> $2
          AND is_primary = FALSE
        ORDER BY bound_at ASC
        LIMIT 1
        FOR UPDATE`,
      [identityId, workosUserId],
    );

    if (successor.rows.length === 0) {
      // Single-credential identity. Nothing to promote — the CASCADE will
      // drop the only binding and the (orphan) identity row alongside it.
      await client.query('ROLLBACK');
      return null;
    }

    const successorId = successor.rows[0].workos_user_id;

    // Demote the deleted user's binding first so the partial unique index
    // `idx_identity_workos_users_one_primary` doesn't reject the promotion.
    await client.query(
      `UPDATE identity_workos_users SET is_primary = FALSE
        WHERE workos_user_id = $1`,
      [workosUserId],
    );
    await client.query(
      `UPDATE identity_workos_users SET is_primary = TRUE
        WHERE workos_user_id = $1 AND identity_id = $2`,
      [successorId, identityId],
    );

    await client.query('COMMIT');

    logger.info(
      { deletedUserId: workosUserId, promotedUserId: successorId, identityId },
      'Promoted secondary to primary before WorkOS user.deleted CASCADE',
    );

    return { promotedUserId: successorId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // logger.warn auto-routes to #admin-errors via posthog.ts:201-205.
    logger.warn(
      { err, userId: workosUserId },
      'Failed to promote secondary on user.deleted — identity may be left with zero primaries',
    );
    // Explicit ops alert so this doesn't drown in the warn stream.
    notifySystemError({
      source: 'workos-webhook',
      errorMessage: `user.deleted: failed to promote secondary for ${workosUserId}; identity may be left with zero primaries and the surviving binding will sign in to an empty workspace until repaired`,
    });
    return null;
  } finally {
    client.release();
  }
}
