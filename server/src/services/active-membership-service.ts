import { getPool } from '../db/client.js';
import {
  invalidateMembershipCache,
  resolveEffectiveMembership,
  type EffectiveMembership,
} from '../db/org-filters.js';
import { createLogger } from '../logger.js';

const logger = createLogger('active-membership-service');

export interface ActiveMembershipCheckDeps {
  listOrganizationIdsForUser: (userId: string) => Promise<string[]>;
  invalidateMembershipCache: (orgId: string) => void;
  resolveEffectiveMembership: (orgId: string) => Promise<EffectiveMembership>;
}

async function listOrganizationIdsForUser(userId: string): Promise<string[]> {
  const result = await getPool().query<{ workos_organization_id: string }>(
    `SELECT DISTINCT workos_organization_id
     FROM organization_memberships
     WHERE workos_user_id = $1`,
    [userId],
  );
  return result.rows.map((row) => row.workos_organization_id);
}

const DEFAULT_DEPS: ActiveMembershipCheckDeps = {
  listOrganizationIdsForUser,
  invalidateMembershipCache,
  resolveEffectiveMembership,
};

/**
 * Check every organization the user belongs to for an active effective
 * AgenticAdvertising.org membership. Each decision bypasses the membership
 * cache so authorization never rests on a recently canceled subscription.
 *
 * `EffectiveMembership.is_member` intentionally includes Explorer
 * (`individual_academic`) and inherited memberships. It does not use the
 * narrower API-access tier list.
 *
 * Resolver and database failures fail closed.
 */
export async function hasActiveMembershipForUser(
  userId: string,
  deps: ActiveMembershipCheckDeps = DEFAULT_DEPS,
): Promise<boolean> {
  try {
    const organizationIds = await deps.listOrganizationIdsForUser(userId);
    if (organizationIds.length === 0) return false;

    const memberships = await Promise.all(
      organizationIds.map((orgId) => {
        deps.invalidateMembershipCache(orgId);
        return deps.resolveEffectiveMembership(orgId);
      }),
    );
    return memberships.some((membership) => membership.is_member);
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to resolve active membership for user');
    return false;
  }
}
