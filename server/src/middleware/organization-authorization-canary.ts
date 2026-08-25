import type { WorkOS } from "@workos-inc/node";
import {
  ORGANIZATION_AUTHORIZATION_BOUNDARIES,
  type OrganizationAuthorizationBoundary,
} from "../auth/organization-authorization-boundaries.js";
import type { OrgAuthorizationPrincipal } from "../auth/organization-principal.js";
import {
  getOrganizationAuthorizationEnforcement,
  type OrganizationAuthorizationEnforcementSetting,
} from "../db/system-settings-db.js";
import { createLogger } from "../logger.js";
import {
  evaluateUserOrgRoleAuthorization,
  resolveUserOrgAuthorization,
  type MembershipRole,
  type UserOrgAuthorizationMembership,
  type OrgAuthorizationSource,
} from "../utils/resolve-user-org-authorization.js";

const logger = createLogger("organization-authorization-canary");
const RUNTIME_SETTING_CACHE_TTL_MS = 5_000;

let runtimeSettingCache:
  | { setting: OrganizationAuthorizationEnforcementSetting; expiresAt: number }
  | null = null;
let runtimeSettingGeneration = 0;
let runtimeSettingPromise:
  | { generation: number; promise: Promise<OrganizationAuthorizationEnforcementSetting> }
  | null = null;

export { ORGANIZATION_AUTHORIZATION_BOUNDARIES };
export type { OrganizationAuthorizationBoundary };

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
      unavailableSources: Array<OrgAuthorizationSource | "runtime_config">;
    };

/**
 * The environment values are a deployment-time ceiling: neither the audited
 * runtime setting nor a typo can enable a boundary not explicitly staged in
 * Fly. Both values default off.
 */
export function isOrganizationAuthorizationBoundaryAllowedByEnvironment(
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

async function getCachedRuntimeSetting(): Promise<OrganizationAuthorizationEnforcementSetting> {
  const now = Date.now();
  if (runtimeSettingCache && runtimeSettingCache.expiresAt > now) {
    return runtimeSettingCache.setting;
  }
  const generation = runtimeSettingGeneration;
  if (!runtimeSettingPromise || runtimeSettingPromise.generation !== generation) {
    const promise = getOrganizationAuthorizationEnforcement()
      .then((setting) => {
        if (generation === runtimeSettingGeneration) {
          runtimeSettingCache = {
            setting,
            expiresAt: Date.now() + RUNTIME_SETTING_CACHE_TTL_MS,
          };
        }
        return setting;
      })
      .finally(() => {
        if (runtimeSettingPromise?.promise === promise) {
          runtimeSettingPromise = null;
        }
      });
    runtimeSettingPromise = { generation, promise };
  }
  return runtimeSettingPromise.promise;
}

/** Clear the local process cache after an audited admin update. */
export function invalidateOrganizationAuthorizationRuntimeSettingCache(): void {
  runtimeSettingGeneration += 1;
  runtimeSettingCache = null;
  runtimeSettingPromise = null;
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
  getRuntimeSetting?: () => Promise<OrganizationAuthorizationEnforcementSetting>;
  minimumRole?: MembershipRole;
}): Promise<OrganizationAuthorizationCanaryDecision> {
  if (!isOrganizationAuthorizationBoundaryAllowedByEnvironment(input.boundary)) {
    return { enforced: false };
  }

  let runtimeSetting: OrganizationAuthorizationEnforcementSetting;
  try {
    runtimeSetting = await (input.getRuntimeSetting?.() ?? getCachedRuntimeSetting());
  } catch (err) {
    logger.error(
      { err, boundary: input.boundary },
      "Organization authorization runtime setting unavailable"
    );
    return {
      enforced: true,
      status: "unavailable",
      unavailableSources: ["runtime_config"],
    };
  }
  if (
    !runtimeSetting.enabled ||
    !runtimeSetting.boundaries.includes(input.boundary)
  ) {
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
