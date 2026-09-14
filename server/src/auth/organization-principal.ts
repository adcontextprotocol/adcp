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

export interface OrganizationAuthenticationStamp {
  readonly credentialId: string;
  readonly canonicalUserId: string;
  readonly identityId: string;
  readonly bindingVersion: string;
  readonly epoch: string | null;
}

// Server-only proof: never serialize identity/binding correlation to clients.
// Auth captures attribution and epoch in one statement, before route work.
const authenticationStamps = new WeakMap<WorkOSUser, Readonly<OrganizationAuthenticationStamp>>();
export function stampOrganizationAuthentication(user: WorkOSUser, stamp: OrganizationAuthenticationStamp): void {
  authenticationStamps.set(user, Object.freeze({ ...stamp }));
}
export function getOrganizationAuthenticationStamp(user: WorkOSUser): Readonly<OrganizationAuthenticationStamp> | undefined {
  return authenticationStamps.get(user);
}
export function copyOrganizationAuthenticationStamp(source: WorkOSUser, target: WorkOSUser): void {
  const stamp = authenticationStamps.get(source);
  if (stamp) authenticationStamps.set(target, stamp);
}
