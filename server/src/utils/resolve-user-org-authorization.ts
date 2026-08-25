import type { WorkOS } from "@workos-inc/node";
import type { OrgAuthorizationPrincipal } from "../auth/organization-principal.js";
import { getOrganizationAuthorizationUserId } from "../auth/organization-principal.js";
import { query } from "../db/client.js";
import { createLogger } from "../logger.js";
import { resolveUserRole } from "./resolve-user-role.js";

const logger = createLogger("resolve-user-org-authorization");

export type MembershipRole = "owner" | "admin" | "member";
export type OrgAuthorizationSource = "workos" | "credential_grant";

export interface UserOrgAuthorizationMembership {
  organizationId: string;
  role: MembershipRole;
  source: OrgAuthorizationSource;
}

export type UserOrgAuthorizationResolution =
  | {
      status: "authorized";
      membership: UserOrgAuthorizationMembership;
      complete: boolean;
      unavailableSources: OrgAuthorizationSource[];
    }
  | { status: "forbidden"; complete: true; unavailableSources: [] }
  | {
      status: "unavailable";
      complete: false;
      unavailableSources: OrgAuthorizationSource[];
    };

export type UserOrgRoleAuthorization =
  | { status: "authorized"; membership: UserOrgAuthorizationMembership }
  | { status: "forbidden" }
  | { status: "unavailable"; unavailableSources: OrgAuthorizationSource[] };

const VALID_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "member"]);
const ROLE_RANK: Record<MembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Resolve exact-credential authority without changing any existing route.
 * Callers must distinguish a definitive denial from an unavailable authority
 * source; enforcement routes should map those to 403 and 503 respectively.
 */
export async function resolveUserOrgAuthorization(
  workos: WorkOS | null,
  principal: OrgAuthorizationPrincipal,
  organizationId: string
): Promise<UserOrgAuthorizationResolution> {
  const userId = getOrganizationAuthorizationUserId(principal);
  let directMembership: UserOrgAuthorizationMembership | null = null;
  let workosAvailable = false;

  if (workos) {
    try {
      const memberships =
        await workos.userManagement.listOrganizationMemberships({
          userId,
          organizationId,
        });
      const matchingMemberships = memberships.data.filter(
        (membership) => membership.organizationId === organizationId
      );
      const activeRow = matchingMemberships.find(
        (membership) => membership.status === "active"
      );
      const role = resolveUserRole(matchingMemberships);
      if (activeRow && role && VALID_ROLES.has(role)) {
        directMembership = {
          organizationId: activeRow.organizationId,
          role: role as MembershipRole,
          source: "workos",
        };
      }
      workosAvailable = true;
    } catch (err) {
      logger.warn(
        { err },
        "WorkOS membership lookup failed; checking explicit credential grant"
      );
    }
  } else {
    logger.warn("WorkOS client unavailable; checking explicit credential grant");
  }

  let grantAvailable = false;
  let grantMembership: UserOrgAuthorizationMembership | null = null;
  try {
    const grant = await query<{ workos_organization_id: string; role: string }>(
      `SELECT workos_organization_id, role
         FROM organization_credential_grants
        WHERE workos_user_id = $1
          AND workos_organization_id = $2
          AND revoked_at IS NULL
          AND effective_from <= NOW()
          AND (effective_until IS NULL OR effective_until > NOW())
        LIMIT 1`,
      [userId, organizationId]
    );
    grantAvailable = true;
    const row = grant.rows[0];
    if (row && VALID_ROLES.has(row.role)) {
      grantMembership = {
        organizationId: row.workos_organization_id,
        role: row.role as MembershipRole,
        source: "credential_grant",
      };
    }
  } catch (err) {
    logger.warn({ err }, "Credential grant lookup failed");
  }

  let membership = directMembership;
  if (
    grantMembership &&
    (!membership ||
      ROLE_RANK[grantMembership.role] > ROLE_RANK[membership.role])
  ) {
    membership = grantMembership;
  }

  const unavailableSources: OrgAuthorizationSource[] = [];
  if (!workosAvailable) unavailableSources.push("workos");
  if (!grantAvailable) unavailableSources.push("credential_grant");

  if (membership) {
    return {
      status: "authorized",
      membership,
      complete: unavailableSources.length === 0,
      unavailableSources,
    };
  }
  if (unavailableSources.length > 0) {
    return { status: "unavailable", complete: false, unavailableSources };
  }
  return { status: "forbidden", complete: true, unavailableSources: [] };
}

/**
 * Apply a minimum role without turning a partial-source outage into a denial.
 * A known sufficient role can authorize; an insufficient role is definitive
 * only when every authority source was consulted successfully.
 */
export function evaluateUserOrgRoleAuthorization(
  resolution: UserOrgAuthorizationResolution,
  minimumRole: MembershipRole = "member"
): UserOrgRoleAuthorization {
  if (resolution.status === "forbidden") return { status: "forbidden" };
  if (resolution.status === "unavailable") {
    return {
      status: "unavailable",
      unavailableSources: resolution.unavailableSources,
    };
  }
  if (ROLE_RANK[resolution.membership.role] >= ROLE_RANK[minimumRole]) {
    return { status: "authorized", membership: resolution.membership };
  }
  return resolution.complete
    ? { status: "forbidden" }
    : {
        status: "unavailable",
        unavailableSources: resolution.unavailableSources,
      };
}
