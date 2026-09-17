/**
 * Web admin-status lookup for AAO admins.
 *
 * Extracted from `mcp/admin-tools.ts` so callers that only need to
 * check `is the WorkOS user an admin?` can do so without dragging in
 * relationship-orchestrator → engagement-planner → Anthropic at module
 * load. Same motivation as `member-context-cache.ts` and
 * `admin-status-cache.ts` (PR #3741) — keep the test import graph
 * small and stop `admin-tools` from being a chokepoint that pulls
 * heavy services into unrelated chains.
 *
 * Platform authority is evaluated for the credential which authenticated.
 * A failed lookup is retryable and distinct from a confirmed lack of authority.
 */

import { createLogger } from '../logger.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import {
  decideAAOAdminAccess,
  isBreakGlassAdminEmail,
  type AAOAdminAccessDecision,
  type AAOAdminAccessMechanism,
} from '../auth/admin-access.js';

export {
  decideAAOAdminAccess,
  type AAOAdminAccessDecision,
  type AAOAdminAccessMechanism,
} from '../auth/admin-access.js';

const logger = createLogger('admin-status-lookup');

const AAO_ADMIN_WORKING_GROUP_SLUG = 'aao-admin';
const wgDb = new WorkingGroupDatabase();

/** A person principal as authenticated, before canonical identity routing. */
export interface AAOAdminPrincipal {
  id: string;
  authWorkosUserId?: string;
  email?: string | null;
}

/** A failed authority lookup is retryable, and must never become a grant or a denial. */
export class AAOAdminLookupUnavailableError extends Error {
  readonly code = 'admin_authorization_unavailable';
  readonly statusCode = 503;

  constructor(options?: ErrorOptions) {
    super('Administrator authorization is temporarily unavailable. Please try again.', options);
    this.name = 'AAOAdminLookupUnavailableError';
  }
}

/** Typed membership lookup used by the authenticated-principal boundary. */
async function lookupWebUserAAOAdmin(workosUserId: string): Promise<boolean> {
  try {
    const adminGroupId = await wgDb.getWorkingGroupIdBySlug(AAO_ADMIN_WORKING_GROUP_SLUG);
    if (!adminGroupId) {
      throw new Error('Platform administrator authority group is missing');
    }

    const isAdmin = await wgDb.isMember(adminGroupId, workosUserId);
    logger.debug({ workosUserId, isAdmin }, 'Checked web user admin status');
    return isAdmin;
  } catch (error) {
    logger.error({ error, workosUserId, code: 'admin_authorization_unavailable' }, 'Platform administrator authorization lookup unavailable');
    throw new AAOAdminLookupUnavailableError({ cause: error });
  }
}

/**
 * Compatibility adapter for web callers migrated in the follow-up sweep.
 * An unavailable lookup remains false here; new authorization code must use
 * the principal-taking resolver to distinguish unavailable from forbidden.
 */
export async function isWebUserAAOAdmin(workosUserId: string): Promise<boolean> {
  try {
    return await lookupWebUserAAOAdmin(workosUserId);
  } catch (error) {
    if (error instanceof AAOAdminLookupUnavailableError) return false;
    throw error;
  }
}

/**
 * Resolve platform-admin access and retain the authority mechanism for audit
 * and diagnostics. Working-group membership is primary; `ADMIN_EMAILS` is
 * only the environment-managed break-glass fallback.
 */
export async function resolveWebUserAAOAdminAccess(
  principal: AAOAdminPrincipal | string,
  email?: string | null,
): Promise<AAOAdminAccessDecision> {
  // Preserve the existing string overload until its web callers migrate.
  if (typeof principal === 'string') {
    return decideAAOAdminAccess(await isWebUserAAOAdmin(principal), email);
  }
  const workosUserId = principal.authWorkosUserId ?? principal.id;
  const authenticatedEmail = principal.email;
  try {
    return decideAAOAdminAccess(await lookupWebUserAAOAdmin(workosUserId), authenticatedEmail);
  } catch (error) {
    // Break-glass is independently configured authority, including during an
    // outage. It never comes from a canonical linked credential's email.
    if (error instanceof AAOAdminLookupUnavailableError && isBreakGlassAdminEmail(authenticatedEmail)) {
      return { isAdmin: true, mechanism: 'break_glass_admin_email' };
    }
    throw error;
  }
}

export async function isAuthenticatedUserAAOAdmin(principal: AAOAdminPrincipal): Promise<boolean> {
  return (await resolveWebUserAAOAdminAccess(principal)).isAdmin;
}
