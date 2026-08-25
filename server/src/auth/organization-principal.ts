import type { WorkOSUser } from "../types.js";

export type OrgAuthorizationPrincipal = Pick<
  WorkOSUser,
  "id" | "authWorkosUserId"
>;

/**
 * Return the exact WorkOS credential that authenticated the request.
 * `principal.id` may have been replaced with the identity's canonical user for
 * legacy person-state reads, so it is unsafe at an organization boundary.
 */
export function getOrganizationAuthorizationUserId(
  principal: OrgAuthorizationPrincipal
): string {
  return principal.authWorkosUserId ?? principal.id;
}
