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
import {
  getOrganizationAuthorizationUserId,
  type OrgAuthorizationPrincipal,
} from '../auth/organization-principal.js';

export {
  getOrganizationAuthorizationUserId,
  type OrgAuthorizationPrincipal,
} from '../auth/organization-principal.js';

const logger = createLogger('resolve-user-org-membership');

export type MembershipRole = 'owner' | 'admin' | 'member';

export interface UserOrgMembership {
  /** Canonical organization ID returned by the authoritative membership row. */
  organizationId: string;
  /** Highest-privilege active role slug (member < admin < owner). */
  role: MembershipRole;
  /** Membership status from WorkOS or 'active' for dev memberships. */
  status: 'active' | 'pending' | 'inactive';
  /** True when authority comes from an explicit organization credential grant. */
  via_credential_grant: boolean;
  /**
   * True when the membership was resolved via the dev-mode bypass (local
   * organization_memberships seed) rather than a live WorkOS lookup. Callers
   * that write audit-log rows should propagate this so post-incident triage
   * can distinguish dev-bypass writes from real-user writes — the dev path
   * uses synthetic user IDs (user_dev_admin_001) that don't resolve in WorkOS.
   */
  via_dev_bypass: boolean;
}

export type OrgAuthorizationSource = 'workos' | 'credential_grant' | 'dev_membership_cache';

export type UserOrgAuthorizationResolution =
  | {
      status: 'authorized';
      membership: UserOrgMembership;
      /** False when another authority source could not be consulted. */
      complete: boolean;
      unavailableSources: OrgAuthorizationSource[];
    }
  | {
      status: 'forbidden';
      complete: true;
      unavailableSources: [];
    }
  | {
      status: 'unavailable';
      complete: false;
      unavailableSources: OrgAuthorizationSource[];
    };

export type UserOrgRoleAuthorization =
  | { status: 'authorized'; membership: UserOrgMembership }
  | { status: 'forbidden' }
  | { status: 'unavailable'; unavailableSources: OrgAuthorizationSource[] };

const VALID_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);
const ROLE_RANK: Record<MembershipRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Apply a minimum-role requirement without converting an authority-source
 * outage into a denial. A known sufficient role is safe to accept even when
 * another independent source is unavailable. A known insufficient role is
 * only a definitive 403 when every source was consulted successfully.
 */
export function evaluateUserOrgRoleAuthorization(
  resolution: UserOrgAuthorizationResolution,
  minimumRole: MembershipRole = 'member',
): UserOrgRoleAuthorization {
  if (resolution.status === 'forbidden') return { status: 'forbidden' };
  if (resolution.status === 'unavailable') {
    return { status: 'unavailable', unavailableSources: resolution.unavailableSources };
  }
  if (ROLE_RANK[resolution.membership.role] >= ROLE_RANK[minimumRole]) {
    return { status: 'authorized', membership: resolution.membership };
  }
  return resolution.complete
    ? { status: 'forbidden' }
    : { status: 'unavailable', unavailableSources: resolution.unavailableSources };
}

/**
 * Resolve the caller's membership in the given org. Returns null when the
 * user is not a member.
 *
 * In dev mode (DEV_USERS), reads from local `organization_memberships`
 * which dev-setup.ts seeds at boot — WorkOS doesn't know about dev users,
 * so we can't defer to it. Production still goes through WorkOS.
 */
export async function resolveUserOrgAuthorization(
  workos: WorkOS | null,
  principal: OrgAuthorizationPrincipal,
  organizationId: string,
): Promise<UserOrgAuthorizationResolution> {
  const userId = getOrganizationAuthorizationUserId(principal);
  let directMembership: UserOrgMembership | null = null;
  // Dev mode bypass: local membership cache is the source of truth.
  if (isDevModeEnabled()) {
    const devUser = Object.values(DEV_USERS).find((du) => du.id === userId);
    if (devUser) {
      try {
        const result = await query<{ workos_organization_id: string; role: string }>(
          `SELECT workos_organization_id, role FROM organization_memberships
           WHERE workos_user_id = $1 AND workos_organization_id = $2`,
          [userId, organizationId],
        );
        if (result.rows.length > 0) {
          const membershipRow = result.rows[0];
          const rawRole = membershipRow.role || 'member';
          const role = (VALID_ROLES.has(rawRole) ? rawRole : 'member') as MembershipRole;
          return {
            status: 'authorized',
            membership: {
              organizationId: membershipRow.workos_organization_id,
              role,
              status: 'active',
              via_dev_bypass: true,
              via_credential_grant: false,
            },
            complete: true,
            unavailableSources: [],
          };
        }
        return { status: 'forbidden', complete: true, unavailableSources: [] };
      } catch (err) {
        logger.warn({ err, userId, organizationId }, 'Dev membership cache lookup failed');
        return {
          status: 'unavailable',
          complete: false,
          unavailableSources: ['dev_membership_cache'],
        };
      }
    }
    // Real users in dev mode (e.g. someone running tsx with their actual
    // WorkOS account) fall through to the WorkOS path below.
  }

  // Prod path: WorkOS is the source of truth.
  let workosAvailable = false;
  if (workos) {
    try {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId,
        organizationId,
      });
      const matchingMemberships = memberships.data.filter(
        (membership) => membership.organizationId === organizationId,
      );
      const activeRow = matchingMemberships.find((membership) => membership.status === 'active');
      const roleSlug = resolveUserRole(matchingMemberships);
      if (activeRow && roleSlug && VALID_ROLES.has(roleSlug)) {
        directMembership = {
          organizationId: activeRow.organizationId,
          role: roleSlug as MembershipRole,
          status: 'active',
          via_dev_bypass: false,
          via_credential_grant: false,
        };
      }
      workosAvailable = true;
    } catch (err) {
      logger.warn({ err, userId, organizationId }, 'WorkOS membership lookup failed; checking explicit credential grant');
    }
  } else {
    logger.warn({ userId, organizationId }, 'WorkOS client not available; checking explicit credential grant');
  }

  let grantAvailable = false;
  let grant: { rows: Array<{ workos_organization_id: string; role: string }> };
  try {
    grant = await query<{ workos_organization_id: string; role: string }>(
      `SELECT workos_organization_id, role
         FROM organization_credential_grants
        WHERE workos_user_id = $1
          AND workos_organization_id = $2
          AND revoked_at IS NULL
          AND effective_from <= NOW()
          AND (effective_until IS NULL OR effective_until > NOW())
        LIMIT 1`,
      [userId, organizationId],
    );
    grantAvailable = true;
  } catch (err) {
    logger.warn({ err, userId, organizationId }, 'Credential grant lookup failed');
    grant = { rows: [] };
  }
  const grantRow = grant.rows[0];
  let effectiveMembership = directMembership;
  if (grantRow && VALID_ROLES.has(grantRow.role)) {
    const grantMembership: UserOrgMembership = {
      organizationId: grantRow.workos_organization_id,
      role: grantRow.role as MembershipRole,
      status: 'active',
      via_dev_bypass: false,
      via_credential_grant: true,
    };
    if (!effectiveMembership || ROLE_RANK[grantMembership.role] > ROLE_RANK[effectiveMembership.role]) {
      effectiveMembership = grantMembership;
    }
  }

  const unavailableSources: OrgAuthorizationSource[] = [];
  if (!workosAvailable) unavailableSources.push('workos');
  if (!grantAvailable) unavailableSources.push('credential_grant');

  if (effectiveMembership) {
    return {
      status: 'authorized',
      membership: effectiveMembership,
      complete: unavailableSources.length === 0,
      unavailableSources,
    };
  }
  if (unavailableSources.length > 0) {
    return { status: 'unavailable', complete: false, unavailableSources };
  }
  return { status: 'forbidden', complete: true, unavailableSources: [] };
}

/**
 * Backward-compatible membership facade. Existing routes intentionally keep
 * their current null/403 behavior until they are moved behind a rollout
 * canary. New enforcement code must use resolveUserOrgAuthorization plus
 * evaluateUserOrgRoleAuthorization so unavailable maps to 503.
 */
export async function resolveUserOrgMembership(
  workos: WorkOS | null,
  principal: OrgAuthorizationPrincipal,
  organizationId: string,
): Promise<UserOrgMembership | null> {
  const resolution = await resolveUserOrgAuthorization(workos, principal, organizationId);
  return resolution.status === 'authorized' ? resolution.membership : null;
}
