import type { Pool } from 'pg';
import { getDomain } from 'tldts';
import { getPool } from '../db/client.js';
import { canonicalizeBrandDomain } from './identifier-normalization.js';

export interface OrgSelectionMemberContext {
  workos_user?: {
    workos_user_id?: string | null;
  } | null;
  organization?: {
    workos_organization_id?: string | null;
    name?: string | null;
    is_personal?: boolean | null;
  } | null;
}

export interface CompanyOrgChoice {
  organizationId: string;
  name: string | null;
}

export type PersonalWorkspaceDomainSelectionResult =
  | { ok: true; checked: boolean; domain?: string }
  | {
      ok: false;
      status: 'org_selection_required';
      domain: string;
      selectedOrg: {
        organizationId: string;
        name: string | null;
      };
      companyOrgs: CompanyOrgChoice[];
    };

export async function guardPersonalWorkspaceDomainSelection(input: {
  memberContext: OrgSelectionMemberContext;
  selectedOrgId: string;
  rawDomain: string;
  pool?: Pool;
}): Promise<PersonalWorkspaceDomainSelectionResult> {
  const workosUserId = input.memberContext.workos_user?.workos_user_id;
  if (!workosUserId) {
    return { ok: true, checked: false };
  }

  let domain: string;
  try {
    const canonical = canonicalizeBrandDomain(input.rawDomain);
    domain = getDomain(canonical, { allowPrivateDomains: true }) ?? canonical;
  } catch {
    return { ok: true, checked: false };
  }

  const ambientOrg = input.memberContext.organization;
  const selectedOrg = ambientOrg?.workos_organization_id === input.selectedOrgId
    ? ambientOrg
    : null;

  if (selectedOrg?.is_personal !== true) {
    if (selectedOrg) {
      return { ok: true, checked: false };
    }

    const lookupPool = input.pool ?? getPool();
    const selectedOrgLookup = (await lookupPool.query<{
      workos_organization_id: string;
      name: string | null;
      is_personal: boolean | null;
    }>(
      `SELECT workos_organization_id, name, is_personal
         FROM organizations
        WHERE workos_organization_id = $1`,
      [input.selectedOrgId],
    )).rows[0] ?? null;

    if (selectedOrgLookup?.is_personal !== true) {
      return { ok: true, checked: false };
    }

    return checkPersonalWorkspaceDomain({
      pool: lookupPool,
      selectedOrg: selectedOrgLookup,
      selectedOrgId: input.selectedOrgId,
      workosUserId,
      domain,
    });
  }

  const pool = input.pool ?? getPool();
  return checkPersonalWorkspaceDomain({
    pool,
    selectedOrg,
    selectedOrgId: input.selectedOrgId,
    workosUserId,
    domain,
  });
}

async function checkPersonalWorkspaceDomain(input: {
  pool: Pool;
  selectedOrg: {
    workos_organization_id?: string | null;
    name?: string | null;
  };
  selectedOrgId: string;
  workosUserId: string;
  domain: string;
}): Promise<PersonalWorkspaceDomainSelectionResult> {
  const result = await input.pool.query<{
    workos_organization_id: string;
    name: string | null;
  }>(
    `SELECT DISTINCT
       o.workos_organization_id,
       o.name
     FROM organizations o
     JOIN organization_memberships om
       ON om.workos_organization_id = o.workos_organization_id
      AND om.workos_user_id = $2
     LEFT JOIN organization_domains od
       ON od.workos_organization_id = o.workos_organization_id
     WHERE COALESCE(o.is_personal, false) = false
       AND o.workos_organization_id <> $3
       AND (
         LOWER(o.email_domain) = LOWER($1)
         OR LOWER(od.domain) = LOWER($1)
       )
     ORDER BY o.name ASC NULLS LAST
     LIMIT 5`,
    [input.domain, input.workosUserId, input.selectedOrgId],
  );

  if (result.rows.length === 0) {
    return { ok: true, checked: true, domain: input.domain };
  }

  return {
    ok: false,
    status: 'org_selection_required',
    domain: input.domain,
    selectedOrg: {
      organizationId:
        input.selectedOrg.workos_organization_id ?? input.selectedOrgId,
      name: input.selectedOrg.name ?? null,
    },
    companyOrgs: result.rows.map((row) => ({
      organizationId: row.workos_organization_id,
      name: row.name,
    })),
  };
}
