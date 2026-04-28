/**
 * Universal "is this user a member of this org, and in what role?" helper.
 *
 * Replaces the copy-pasted pattern across admin-only org endpoints:
 *
 *   const memberships = await workos.userManagement.listOrganizationMemberships({
 *     userId, organizationId,
 *   });
 *   if (memberships.data.length === 0) return res.status(403)...
 *   const role = resolveUserRole(memberships.data);
 *
 * The pattern above 403s in dev mode for every dev user (WorkOS doesn't know
 * about them), forcing each route to add its own dev-mode bypass. This helper
 * does it once: in dev mode it reads from the local `organization_memberships`
 * cache (seeded by dev-setup.ts), in prod it defers to WorkOS as source of
 * truth.
 *
 * Returns null when the user is not a member of the requested org. Callers
 * then send their own 403 with appropriate message text.
 */

import type { WorkOS } from '@workos-inc/node';
import { DEV_USERS, isDevModeEnabled } from '../middleware/auth.js';
import { resolveUserRole } from './resolve-user-role.js';
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('resolve-user-org-membership');

export type MembershipRole = 'owner' | 'admin' | 'member';

export interface UserOrgMembership {
  /** Highest-privilege active role slug (member < admin < owner). */
  role: MembershipRole;
  /** Membership status from WorkOS or 'active' for dev memberships. */
  status: 'active' | 'pending' | 'inactive';
  /**
   * True when the membership was resolved via the dev-mode bypass (local
   * organization_memberships seed) rather than a live WorkOS lookup. Callers
   * that write audit-log rows should propagate this so post-incident triage
   * can distinguish dev-bypass writes from real-user writes — the dev path
   * uses synthetic user IDs (user_dev_admin_001) that don't resolve in WorkOS.
   */
  via_dev_bypass: boolean;
}

const VALID_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

/**
 * Resolve the caller's membership in the given org. Returns null when the
 * user is not a member.
 *
 * In dev mode (DEV_USERS), reads from local `organization_memberships`
 * which dev-setup.ts seeds at boot — WorkOS doesn't know about dev users,
 * so we can't defer to it. Production still goes through WorkOS.
 */
export async function resolveUserOrgMembership(
  workos: WorkOS | null,
  userId: string,
  organizationId: string,
): Promise<UserOrgMembership | null> {
  // Dev mode bypass: local membership cache is the source of truth.
  if (isDevModeEnabled()) {
    const devUser = Object.values(DEV_USERS).find((du) => du.id === userId);
    if (devUser) {
      const result = await query<{ role: string }>(
        `SELECT role FROM organization_memberships
         WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, organizationId],
      );
      if (result.rows.length === 0) return null;
      const rawRole = result.rows[0].role || 'member';
      const role = (VALID_ROLES.has(rawRole) ? rawRole : 'member') as MembershipRole;
      return { role, status: 'active', via_dev_bypass: true };
    }
    // Real users in dev mode (e.g. someone running tsx with their actual
    // WorkOS account) fall through to the WorkOS path below.
  }

  // Prod path: WorkOS is the source of truth.
  if (!workos) {
    logger.warn({ userId, organizationId }, 'WorkOS client not available — cannot resolve membership');
    return null;
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    organizationId,
  });

  if (memberships.data.length === 0) return null;

  const roleSlug = resolveUserRole(memberships.data);
  if (!roleSlug || !VALID_ROLES.has(roleSlug)) return null;

  // Pick the active row's status if any; otherwise the first.
  const activeRow = memberships.data.find((m) => m.status === 'active');
  const status = (activeRow?.status ?? memberships.data[0].status) as 'active' | 'pending' | 'inactive';

  return { role: roleSlug as MembershipRole, status, via_dev_bypass: false };
}
