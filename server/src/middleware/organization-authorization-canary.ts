import type { WorkOS } from "@workos-inc/node";
import type { OrgAuthorizationPrincipal } from "../auth/organization-principal.js";
import { createLogger } from "../logger.js";
import {
  evaluateUserOrgRoleAuthorization,
  resolveUserOrgAuthorization,
  type MembershipRole,
  type UserOrgAuthorizationMembership,
  type OrgAuthorizationSource,
} from "../utils/resolve-user-org-authorization.js";

const logger = createLogger("organization-authorization-canary");

export const ORGANIZATION_AUTHORIZATION_BOUNDARIES = {
  ORGANIZATION_ROLES_READ: "organization_roles_read",
} as const;

export type OrganizationAuthorizationBoundary =
  (typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES)[keyof typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES];

export type OrganizationAuthorizationCanaryDecision =
  | { enforced: false }
  | {
      enforced: true;
      status: "authorized";
      membership: UserOrgAuthorizationMembership;
    }
  | { enforced: true; status: "forbidden" }
  | {
      enforced: true;
      status: "unavailable";
      unavailableSources: OrgAuthorizationSource[];
    };

/**
 * Enforcement requires both switches. The global switch is the emergency
 * stop; the fixed boundary allowlist prevents a typo or newly added route from
 * expanding the canary. Both default off.
 */
export function isOrganizationAuthorizationBoundaryEnabled(
  boundary: OrganizationAuthorizationBoundary
): boolean {
  if (process.env.ORG_AUTHORIZATION_ENFORCEMENT_ENABLED !== "true")
    return false;
  const enabledBoundaries = new Set(
    (process.env.ORG_AUTHORIZATION_ENFORCEMENT_BOUNDARIES ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return enabledBoundaries.has(boundary);
}

/**
 * Evaluate a default-off route boundary. The WorkOS factory is lazy so the
 * disabled path performs no new lookup or configuration work. Failure to
 * construct the client is represented as an unavailable WorkOS source; an
 * independently sufficient credential grant can still authorize.
 */
export async function evaluateOrganizationAuthorizationCanary(input: {
  boundary: OrganizationAuthorizationBoundary;
  principal: OrgAuthorizationPrincipal;
  organizationId: string;
  getWorkos: () => WorkOS | null;
  minimumRole?: MembershipRole;
}): Promise<OrganizationAuthorizationCanaryDecision> {
  if (!isOrganizationAuthorizationBoundaryEnabled(input.boundary)) {
    return { enforced: false };
  }

  let workos: WorkOS | null = null;
  try {
    workos = input.getWorkos();
  } catch (err) {
    logger.warn(
      { err, boundary: input.boundary },
      "Authorization WorkOS client unavailable"
    );
  }

  const resolution = await resolveUserOrgAuthorization(
    workos,
    input.principal,
    input.organizationId
  );
  const decision = evaluateUserOrgRoleAuthorization(
    resolution,
    input.minimumRole
  );
  if (decision.status === "authorized") {
    return {
      enforced: true,
      status: "authorized",
      membership: decision.membership,
    };
  }
  if (decision.status === "unavailable") {
    return {
      enforced: true,
      status: "unavailable",
      unavailableSources: decision.unavailableSources,
    };
  }
  return { enforced: true, status: "forbidden" };
}
