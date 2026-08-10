import type {
  MembershipRole,
  UserOrgMembership,
} from '../utils/resolve-user-org-membership.js';

export type BillingManagerRole = Extract<MembershipRole, 'owner' | 'admin'>;

/** Billing management can change payment methods, tiers, and cancellation. */
export function isBillingManagerRole(role: unknown): role is BillingManagerRole {
  return role === 'owner' || role === 'admin';
}

/**
 * Bind billing-management authority to an active membership in the exact org
 * being managed. The organization match is intentionally repeated here so a
 * filtered WorkOS response containing a row for another org fails closed.
 */
export function canManageOrganizationBilling(
  membership: Pick<UserOrgMembership, 'organizationId' | 'role' | 'status'> | null | undefined,
  organizationId: string,
): boolean {
  return membership?.organizationId === organizationId
    && membership.status === 'active'
    && isBillingManagerRole(membership.role);
}
