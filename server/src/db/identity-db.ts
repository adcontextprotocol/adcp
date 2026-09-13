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
import { assertIdentityConsolidationAllowed } from './identity-mutation-policy.js';
import { bumpAuthorizationEpochs } from './authorization-epoch-db.js';
import { createLogger } from '../logger.js';
import { notifySystemError } from '../addie/error-notifier.js';

const logger = createLogger('identity-db');

/**
 * Apply an authoritative provider deletion without selecting a new primary.
 * Revoke cached routing for every affected credential in the same transaction
 * as the binding disappears. Return the IDs to evict from local caches after
 * commit; their persisted epochs handle caches on other instances.
 */
export async function deleteIdentityCredential(workosUserId: string): Promise<string[]> {
  const client = await getPool().connect();
  let affectedUserIds: string[] = [workosUserId];
  let orphanedIdentity: { id: string; survivingCredentials: number } | undefined;

  try {
    await client.query('BEGIN');
    // Use a stable lock order when simultaneous webhooks delete siblings.
    // Unlink also needs the binding row lock before it can change the identity.
    const bound = await client.query<{ workos_user_id: string; identity_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, identity_id, is_primary FROM identity_workos_users
       WHERE identity_id = (
         SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
       )
       ORDER BY workos_user_id
       FOR UPDATE`,
      [workosUserId],
    );
    affectedUserIds = [...new Set([
      workosUserId,
      ...bound.rows.map((row) => row.workos_user_id),
    ])];
    const deletedBinding = bound.rows.find((row) => row.workos_user_id === workosUserId);
    const survivors = bound.rows.filter((row) => row.workos_user_id !== workosUserId);
    if (deletedBinding && survivors.length > 0 && !survivors.some((row) => row.is_primary)) {
      orphanedIdentity = { id: deletedBinding.identity_id, survivingCredentials: survivors.length };
    }

    // Authentication checks the actual credential's epoch, so deleting the
    // primary's epoch alone would leave each surviving credential's cache valid.
    await bumpAuthorizationEpochs(client, affectedUserIds);
    await client.query('DELETE FROM users WHERE workos_user_id = $1', [workosUserId]);
    await client.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [workosUserId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Signal the committed access disruption without choosing a successor or
  // inferring lost provenance. Rollbacks and replays without a binding do not
  // report it. Notification failure must not prevent post-commit invalidation.
  if (orphanedIdentity) {
    logger.warn({
      deletedUserId: workosUserId,
      identityId: orphanedIdentity.id,
      survivingCredentialCount: orphanedIdentity.survivingCredentials,
    }, 'Provider deletion left surviving credentials without a primary; operator review required');
    try {
      notifySystemError({
        source: 'identity-primary-missing',
        errorMessage: `Identity ${orphanedIdentity.id} has ${orphanedIdentity.survivingCredentials} surviving credential(s) and no primary after WorkOS user.deleted for ${workosUserId}. Operator review is required; automatic promotion and historical restoration remain disabled.`,
      });
    } catch (err) {
      logger.error({ err, identityId: orphanedIdentity.id }, 'Failed to report identity without a primary');
    }
  }
  return affectedUserIds;
}

/**
 * Legacy primary promotion is disabled for #6827: changing the canonical
 * credential can transfer authority even without moving membership rows.
 * Provider deletions use deleteIdentityCredential without inferring a successor.
 * @throws IdentityMutationDisabledError before any database access.
 */
export async function promoteSecondaryIfPrimaryDeleted(
  workosUserId: string,
): Promise<{ promotedUserId: string } | null> {
  // A primary flip changes canonical authority even without moving rows.
  assertIdentityConsolidationAllowed();
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

    // The primary flipped: every session bound to this identity now routes
    // through a different credential, including secondaries that were not
    // promoted — their canonical target moves from the deleted primary to
    // the successor. Bump all of them in this transaction so stale sessions
    // on other instances lose their pre-promotion routing. The deleted
    // user's binding is still present here; the CASCADE fires later.
    const boundCredentials = await client.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1`,
      [identityId],
    );
    await bumpAuthorizationEpochs(client, [
      workosUserId,
      successorId,
      ...boundCredentials.rows.map((row) => row.workos_user_id),
    ]);

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
