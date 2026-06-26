import type { WorkOS } from '@workos-inc/node';
import type { Pool } from 'pg';
import { getPool } from '../db/client.js';
import {
  syncOrganizationDomains,
  type OrganizationData,
} from '../routes/workos-webhooks.js';

interface LocalDomainSnapshot {
  domain: string;
  workos_organization_id: string;
  organization_name: string | null;
  verified: boolean;
  is_primary: boolean;
  source: string;
}

interface WorkosDomainSnapshot {
  domain: string;
  state: string;
}

export interface DomainReconciliationMismatch {
  domain: string;
  reason: 'missing_local_row' | 'wrong_local_org' | 'verified_mismatch';
  workos_state: string;
  local?: LocalDomainSnapshot;
}

export interface WorkosDomainReconciliationResult {
  organization_id: string;
  organization_name: string;
  workos_domains: WorkosDomainSnapshot[];
  before: LocalDomainSnapshot[];
  after: LocalDomainSnapshot[];
  before_mismatches: DomainReconciliationMismatch[];
  after_mismatches: DomainReconciliationMismatch[];
  changed: boolean;
}

async function loadLocalRowsForDomains(
  pool: Pool,
  domains: string[],
): Promise<LocalDomainSnapshot[]> {
  if (domains.length === 0) return [];
  const result = await pool.query<LocalDomainSnapshot>(
    `SELECT
       od.domain,
       od.workos_organization_id,
       o.name AS organization_name,
       od.verified,
       od.is_primary,
       od.source
     FROM organization_domains od
     LEFT JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
     WHERE od.domain = ANY($1::text[])
     ORDER BY od.domain ASC`,
    [domains],
  );
  return result.rows;
}

function findMismatches(
  orgId: string,
  workosDomains: WorkosDomainSnapshot[],
  localRows: LocalDomainSnapshot[],
): DomainReconciliationMismatch[] {
  const byDomain = new Map(localRows.map((row) => [row.domain.toLowerCase(), row]));
  const mismatches: DomainReconciliationMismatch[] = [];

  for (const workosDomain of workosDomains) {
    const state = String(workosDomain.state);
    const expectsVerified = state === 'verified' || state === 'legacy_verified';
    const domain = workosDomain.domain.toLowerCase();
    const local = byDomain.get(domain);

    if (!local) {
      mismatches.push({
        domain,
        reason: 'missing_local_row',
        workos_state: state,
      });
      continue;
    }

    if (local.workos_organization_id !== orgId) {
      mismatches.push({
        domain,
        reason: 'wrong_local_org',
        workos_state: state,
        local,
      });
      continue;
    }

    if (expectsVerified && !local.verified) {
      mismatches.push({
        domain,
        reason: 'verified_mismatch',
        workos_state: state,
        local,
      });
    }
  }

  return mismatches;
}

export async function reconcileWorkosOrganizationDomains(input: {
  workos: WorkOS;
  orgId: string;
  pool?: Pool;
}): Promise<WorkosDomainReconciliationResult> {
  const pool = input.pool ?? getPool();
  const workosOrg = await input.workos.organizations.getOrganization(input.orgId);
  const workosDomains = workosOrg.domains.map((d) => ({
    domain: d.domain.toLowerCase(),
    state: String(d.state),
  }));
  const domainNames = workosDomains.map((d) => d.domain);

  const before = await loadLocalRowsForDomains(pool, domainNames);
  const beforeMismatches = findMismatches(workosOrg.id, workosDomains, before);

  const orgData: OrganizationData = {
    id: workosOrg.id,
    name: workosOrg.name,
    domains: workosDomains.map((d) => ({
      domain: d.domain,
      state: d.state === 'verified' || d.state === 'legacy_verified' ? 'verified' : 'pending',
    })),
    created_at: workosOrg.createdAt ?? new Date().toISOString(),
    updated_at: workosOrg.updatedAt ?? new Date().toISOString(),
  };

  await syncOrganizationDomains(orgData);

  const after = await loadLocalRowsForDomains(pool, domainNames);
  const afterMismatches = findMismatches(workosOrg.id, workosDomains, after);

  return {
    organization_id: workosOrg.id,
    organization_name: workosOrg.name,
    workos_domains: workosDomains,
    before,
    after,
    before_mismatches: beforeMismatches,
    after_mismatches: afterMismatches,
    changed: JSON.stringify(before) !== JSON.stringify(after),
  };
}
