import type { WorkOS } from '@workos-inc/node';
import { getPool } from '../db/client.js';
import type { OrganizationDatabase } from '../db/organization-db.js';
import { createLogger } from '../logger.js';
import {
  getOrganizationAuthorizationUserId,
  type OrgAuthorizationPrincipal,
} from '../utils/resolve-user-org-membership.js';

const logger = createLogger('current-user-organizations');

export interface CurrentUserOrganization {
  id: string;
  name: string;
  role: string;
  status: string;
  is_personal: boolean;
}

export class CurrentUserOrganizationsUnavailableError extends Error {
  constructor(message = 'Organization membership temporarily unavailable') {
    super(message);
    this.name = 'CurrentUserOrganizationsUnavailableError';
  }
}

interface CurrentUserWorkOSMembership {
  organizationId: string;
  role?: { slug?: string | null } | string | null;
  status?: string | null;
}

type CurrentUserOrgDb = Pick<OrganizationDatabase, 'getOrganization'>;

export type AutoLinkByVerifiedDomain = (
  workos: WorkOS,
  userId: string,
  email: string,
) => Promise<unknown>;

export function getMembershipRole(role: CurrentUserWorkOSMembership['role']): string {
  if (typeof role === 'string' && role.trim()) return role.trim();
  if (role && typeof role === 'object' && typeof role.slug === 'string' && role.slug.trim()) {
    return role.slug.trim();
  }
  return 'member';
}

export async function getCachedOrganizationsForUser(userId: string): Promise<CurrentUserOrganization[]> {
  const pool = getPool();
  const result = await pool.query<{
    workos_organization_id: string;
    name: string | null;
    role: string | null;
    is_personal: boolean | null;
  }>(
    `SELECT
       om.workos_organization_id,
       o.name,
       om.role,
       COALESCE(o.is_personal, false) AS is_personal
     FROM organization_memberships om
     LEFT JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
     WHERE om.workos_user_id = $1
     ORDER BY COALESCE(NULLIF(o.name, ''), om.workos_organization_id)`,
    [userId],
  );

  // The local membership table has no status column. It is an active-membership
  // cache; non-active WorkOS webhook updates must delete rows from this table.
  return result.rows.map(row => ({
    id: row.workos_organization_id,
    name: row.name?.trim() || row.workos_organization_id,
    role: row.role?.trim() || 'member',
    status: 'active',
    is_personal: row.is_personal || false,
  }));
}

async function getGrantedOrganizationsForUser(userId: string): Promise<CurrentUserOrganization[]> {
  const result = await getPool().query<{
    workos_organization_id: string;
    name: string | null;
    role: string;
    is_personal: boolean | null;
  }>(
    `SELECT g.workos_organization_id, o.name, g.role,
            COALESCE(o.is_personal, false) AS is_personal
       FROM organization_credential_grants g
       LEFT JOIN organizations o
         ON o.workos_organization_id = g.workos_organization_id
      WHERE g.workos_user_id = $1
        AND g.revoked_at IS NULL
        AND g.effective_from <= NOW()
        AND (g.effective_until IS NULL OR g.effective_until > NOW())
      ORDER BY COALESCE(NULLIF(o.name, ''), g.workos_organization_id)`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.workos_organization_id,
    name: row.name?.trim() || row.workos_organization_id,
    role: row.role,
    status: 'active',
    is_personal: row.is_personal || false,
  }));
}

function mergeOrganizationAccess(
  memberships: CurrentUserOrganization[],
  grants: CurrentUserOrganization[],
): CurrentUserOrganization[] {
  const rank: Record<string, number> = { member: 1, admin: 2, owner: 3 };
  const merged = new Map<string, CurrentUserOrganization>();
  for (const organization of [...memberships, ...grants]) {
    const existing = merged.get(organization.id);
    if (!existing || (rank[organization.role] ?? 0) > (rank[existing.role] ?? 0)) {
      merged.set(organization.id, organization);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveCurrentUserOrganization(
  membership: CurrentUserWorkOSMembership,
  orgDb: CurrentUserOrgDb,
  workosClient: WorkOS,
): Promise<CurrentUserOrganization> {
  const localOrg = await orgDb.getOrganization(membership.organizationId);

  try {
    const workosOrg = await workosClient.organizations.getOrganization(membership.organizationId);
    return {
      id: membership.organizationId,
      name: workosOrg.name,
      role: getMembershipRole(membership.role),
      status: membership.status || 'active',
      is_personal: localOrg?.is_personal || false,
    };
  } catch (error) {
    logger.warn(
      { err: error, orgId: membership.organizationId },
      'WorkOS organization detail lookup failed for /api/me; using local organization cache',
    );
    return {
      id: membership.organizationId,
      name: localOrg?.name?.trim() || membership.organizationId,
      role: getMembershipRole(membership.role),
      status: membership.status || 'active',
      is_personal: localOrg?.is_personal || false,
    };
  }
}

export async function getCurrentUserOrganizations(args: {
  principal: OrgAuthorizationPrincipal;
  email: string;
  workos: WorkOS | null;
  orgDb: CurrentUserOrgDb;
  autoLinkByVerifiedDomain: AutoLinkByVerifiedDomain;
}): Promise<CurrentUserOrganization[]> {
  const userId = getOrganizationAuthorizationUserId(args.principal);
  if (!args.workos) {
    const [memberships, grants] = await Promise.all([
      getCachedOrganizationsForUser(userId),
      getGrantedOrganizationsForUser(userId),
    ]);
    return mergeOrganizationAccess(memberships, grants);
  }

  try {
    let memberships = await args.workos.userManagement.listOrganizationMemberships({
      userId,
      statuses: ['active'],
    });

    try {
      const linked = await args.autoLinkByVerifiedDomain(args.workos, userId, args.email);
      if (linked) {
        memberships = await args.workos.userManagement.listOrganizationMemberships({
          userId,
          statuses: ['active'],
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, userId },
        'Auto-link by verified domain failed during /api/me; continuing with existing memberships',
      );
    }

    const [resolvedMemberships, grants] = await Promise.all([
      Promise.all(
      memberships.data.map((membership) => resolveCurrentUserOrganization(membership, args.orgDb, args.workos!))
      ),
      getGrantedOrganizationsForUser(userId),
    ]);
    return mergeOrganizationAccess(resolvedMemberships, grants);
  } catch (error) {
    logger.warn(
      { err: error, userId },
      'WorkOS organization membership lookup failed for /api/me',
    );
    throw new CurrentUserOrganizationsUnavailableError();
  }
}
