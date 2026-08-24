import type { WorkOSUser } from '../types.js';

export type OrgAuthorizationPrincipal = Pick<WorkOSUser, 'id' | 'authWorkosUserId'>;

/**
 * Return the WorkOS credential that authenticated the request. `user.id` may
 * be the identity's canonical WorkOS user for legacy person-state reads, so it
 * is not safe to consume directly at an organization-authorization boundary.
 */
export function getOrganizationAuthorizationUserId(
  principal: OrgAuthorizationPrincipal,
): string {
  return principal.authWorkosUserId ?? principal.id;
}
