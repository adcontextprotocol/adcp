/**
 * Invariant (sampled): verified WorkOS organization domains are mirrored into
 * local organization_domains as verified rows for the same org.
 *
 * WorkOS is the DNS proof-of-control source of truth. The local table gates
 * registry membership, brand sync, and save_agent hostname ownership. If a
 * WorkOS verified domain is missing locally, attached to a different org, or
 * still marked unverified, the member sees "member:null" / save_agent blocked
 * even though WorkOS has already accepted DNS verification.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

const DEFAULT_SAMPLE_SIZE = 200;

interface OrgRow {
  workos_organization_id: string;
  name: string;
}

interface LocalDomainRow {
  domain: string;
  workos_organization_id: string;
  org_name: string | null;
  verified: boolean;
  is_primary: boolean;
}

export const workosVerifiedDomainsMirroredInvariant: Invariant = {
  name: 'workos-verified-domains-mirrored',
  description:
    'Sampled organizations with WorkOS-verified domains must have matching verified local organization_domains rows. Catches missed WorkOS domain webhooks and local domain ownership drift that blocks registry membership and save_agent.',
  severity: 'critical',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, workos, logger, options } = ctx;
    const sampleSize = options?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    const violations: Violation[] = [];

    const orgs = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name
         FROM organizations
        WHERE workos_organization_id IS NOT NULL
        ORDER BY RANDOM()
        LIMIT $1`,
      [sampleSize],
    );

    for (const org of orgs.rows) {
      try {
        const workosOrg = await workos.organizations.getOrganization(org.workos_organization_id);
        const verifiedDomains = workosOrg.domains
          .filter((d) => String(d.state) === 'verified' || String(d.state) === 'legacy_verified')
          .map((d) => d.domain.toLowerCase());
        if (verifiedDomains.length === 0) continue;

        const local = await pool.query<LocalDomainRow>(
          `SELECT
             od.domain,
             od.workos_organization_id,
             o.name AS org_name,
             od.verified,
             od.is_primary
           FROM organization_domains od
           LEFT JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
           WHERE od.domain = ANY($1::text[])`,
          [verifiedDomains],
        );
        const localByDomain = new Map(local.rows.map((row) => [row.domain.toLowerCase(), row]));

        for (const domain of verifiedDomains) {
          const row = localByDomain.get(domain);
          if (!row) {
            violations.push({
              invariant: 'workos-verified-domains-mirrored',
              severity: 'critical',
              subject_type: 'domain',
              subject_id: domain,
              message:
                `WorkOS says ${domain} is verified for "${org.name}" (${org.workos_organization_id}), ` +
                'but organization_domains has no local row.',
              details: {
                domain,
                workos_organization_id: org.workos_organization_id,
                organization_name: org.name,
                local_state: 'missing',
              },
              remediation_hint:
                `Replay WorkOS domain reconciliation for org ${org.workos_organization_id}; this should call upsertWorkosDomain and brand registry sync.`,
            });
            continue;
          }

          if (row.workos_organization_id !== org.workos_organization_id) {
            violations.push({
              invariant: 'workos-verified-domains-mirrored',
              severity: 'critical',
              subject_type: 'domain',
              subject_id: domain,
              message:
                `WorkOS says ${domain} is verified for "${org.name}" (${org.workos_organization_id}), ` +
                `but the local row belongs to "${row.org_name ?? 'unknown'}" (${row.workos_organization_id}).`,
              details: {
                domain,
                workos_organization_id: org.workos_organization_id,
                organization_name: org.name,
                local_workos_organization_id: row.workos_organization_id,
                local_organization_name: row.org_name,
                local_verified: row.verified,
              },
              remediation_hint:
                `Replay WorkOS domain reconciliation for org ${org.workos_organization_id}; WorkOS-sourced upserts are allowed to transfer local domain ownership.`,
            });
            continue;
          }

          if (!row.verified) {
            violations.push({
              invariant: 'workos-verified-domains-mirrored',
              severity: 'critical',
              subject_type: 'domain',
              subject_id: domain,
              message:
                `WorkOS says ${domain} is verified for "${org.name}" (${org.workos_organization_id}), ` +
                'but the local organization_domains row is still unverified.',
              details: {
                domain,
                workos_organization_id: org.workos_organization_id,
                organization_name: org.name,
                local_verified: row.verified,
                local_is_primary: row.is_primary,
              },
              remediation_hint:
                `Replay WorkOS domain reconciliation for org ${org.workos_organization_id}; local verified should mirror WorkOS verified.`,
            });
          }
        }
      } catch (err) {
        logger.warn(
          { err, orgId: org.workos_organization_id },
          'workos-verified-domains-mirrored: WorkOS organization lookup failed',
        );
        violations.push({
          invariant: 'workos-verified-domains-mirrored',
          severity: 'warning',
          subject_type: 'organization',
          subject_id: org.workos_organization_id,
          message: `WorkOS organization lookup failed for ${org.workos_organization_id}: ${err instanceof Error ? err.message : String(err)}`,
          details: {
            workos_organization_id: org.workos_organization_id,
            organization_name: org.name,
          },
        });
      }
    }

    return { checked: orgs.rows.length, violations };
  },
};
