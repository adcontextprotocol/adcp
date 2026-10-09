import type { WorkOS } from "@workos-inc/node";
import type { OrgAuthorizationPrincipal } from "../auth/organization-principal.js";
import { getOrganizationAuthorizationUserId } from "../auth/organization-principal.js";
import {
  loadAuthorizationSnapshot,
  sameAuthorizationIdentity,
  sameAuthorizationSnapshot,
  type AuthorizationSnapshot,
} from "../db/user-authorization-snapshot-db.js";
import { createLogger } from "../logger.js";
import { resolveUserRole } from "./resolve-user-role.js";

const logger = createLogger("resolve-user-org-authorization");

export type MembershipRole = "owner" | "admin" | "member";
export type OrgAuthorizationSource = "workos" | "credential_grant" | "authorization_snapshot";

export interface UserOrgAuthorizationMembership {
  organizationId: string;
  role: MembershipRole;
  source: "workos" | "credential_grant";
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
  const forbidden: UserOrgAuthorizationResolution = {
    status: "forbidden", complete: true, unavailableSources: [],
  };
  const unavailable = {
    status: "unavailable", complete: false, unavailableSources: ["authorization_snapshot"],
  } satisfies UserOrgAuthorizationResolution;
  // Signing in alone does not select an organization or confer tenant access.
  if (!organizationId?.trim()) return forbidden;
  const userId = getOrganizationAuthorizationUserId(principal);
  let snapshot: AuthorizationSnapshot | null;
  try {
    snapshot = await loadAuthorizationSnapshot(userId, organizationId);
  } catch (err) {
    logger.warn({ err }, "Primary authorization snapshot unavailable");
    return unavailable;
  }
  if (!snapshot) return forbidden;
  const previous = principal.authorizationSnapshot;
  if (previous) {
    // A sign-in with no org can bind an explicit route selection here. Once
    // selected, a context belongs to that org and grant: replay cannot switch
    // it or silently upgrade a revoked/replaced grant without a fresh request.
    const current = previous.selectedOrganizationId === null
      ? sameAuthorizationIdentity(previous, snapshot)
      : sameAuthorizationSnapshot(previous, snapshot);
    if (!current) return forbidden;
  }

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
        (membership) => membership.userId === userId && membership.organizationId === organizationId
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

  // WorkOS is an asynchronous authority source. Reject this decision if the
  // persisted identity, epoch, selection or grant moved while it was in flight.
  // In particular, never combine a pre-change provider decision with a new grant.
  try {
    const current = await loadAuthorizationSnapshot(userId, organizationId);
    if (!current || !sameAuthorizationSnapshot(snapshot, current)) {
      return forbidden;
    }
  } catch (err) {
    logger.warn({ err }, "Primary authorization snapshot revalidation unavailable");
    return unavailable;
  }
  const grantMembership: UserOrgAuthorizationMembership | null = snapshot.credentialGrant
    ? {
        organizationId: snapshot.credentialGrant.organizationId,
        role: snapshot.credentialGrant.role,
        source: "credential_grant",
      }
    : null;

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
