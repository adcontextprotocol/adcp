/**
 * Single route-facing owner for confirmed WorkOS credential deletion.
 *
 * The DB helper commits locks, membership deletion, epochs, and durable audit
 * together. This service then evicts process-local caches and raises the
 * operator alert. No caller may infer or promote a replacement primary.
 */

import {
  deleteIdentityCredentialTransaction,
  type IdentityCredentialDeletionResult,
  type IdentityCredentialDeletionSource,
} from '../db/identity-db.js';
import { invalidateSessionsForUsers } from '../middleware/auth.js';
import { invalidateUnifiedUsersCache } from '../cache/unified-users.js';
import { notifySystemError } from '../addie/error-notifier.js';
import { createLogger } from '../logger.js';
import {
  invalidateSlackAdminStatusCache,
  invalidateWebAdminStatusCache,
} from '../addie/admin-status-cache.js';
import { invalidateMemberContextCache } from '../addie/member-context-cache.js';
import { invalidateHomeCache } from '../addie/home/cache.js';

const logger = createLogger('identity-credential-deletion');

export async function deleteIdentityCredential(
  workosUserId: string,
  deletionSource: IdentityCredentialDeletionSource,
): Promise<IdentityCredentialDeletionResult> {
  const result = await deleteIdentityCredentialTransaction(workosUserId, deletionSource);

  invalidateSessionsForUsers(result.affectedUserIds);
  invalidateUnifiedUsersCache();
  for (const workosUserId of result.affectedUserIds) {
    invalidateWebAdminStatusCache(workosUserId);
  }
  for (const slackUserId of result.affectedSlackUserIds) {
    invalidateSlackAdminStatusCache(slackUserId);
    invalidateMemberContextCache(slackUserId);
    invalidateHomeCache(slackUserId);
  }

  if (result.quarantine) {
    const { quarantine } = result;
    logger.warn({
      identityId: quarantine.identity_id,
      deletedWorkosUserId: quarantine.deleted_workos_user_id,
      recoveryState: quarantine.recovery_state,
      auditId: quarantine.audit_id,
    }, 'Primary credential deletion requires manual recovery');
    try {
      notifySystemError({
        source: `identity-primary-deletion-quarantine:${quarantine.identity_id}`,
        errorMessage: [
          `Primary credential ${quarantine.deleted_workos_user_id} was deleted without promotion.`,
          `Identity ${quarantine.identity_id} is quarantined.`,
          `recovery_state=${quarantine.recovery_state}.`,
          `audit_id=${quarantine.audit_id}.`,
        ].join(' '),
      });
    } catch (err) {
      // Durable recovery state is already committed. Alert transport failure
      // must not undo containment or prevent post-commit cache eviction.
      logger.error({ err, identityId: quarantine.identity_id, auditId: quarantine.audit_id },
        'Failed to deliver primary-deletion recovery alert');
    }
  }

  return result;
}
