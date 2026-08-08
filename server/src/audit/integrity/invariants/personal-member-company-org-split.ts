/**
 * Invariant: an active paid personal workspace should not be the place where a
 * domain is being verified when the same user also belongs to a non-personal
 * company org for that domain.
 *
 * This catches the "paid individual workspace vs. company prospect org" split
 * that makes UI membership look active while registry/domain operations target
 * the wrong org.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

interface SplitRow {
  personal_org_id: string;
  personal_org_name: string;
  company_org_id: string;
  company_org_name: string;
  domain: string;
  domain_verified: boolean;
  user_email: string;
  company_member_status: string | null;
  company_subscription_status: string | null;
}

export const personalMemberCompanyOrgSplitInvariant: Invariant = {
  name: 'personal-member-company-org-split',
  description:
    'Flags active paid personal workspaces that hold or are verifying a domain for a company org the same user owns/belongs to. Prevents Addie and support from mistaking personal membership for company registry readiness.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool } = ctx;

    const result = await pool.query<SplitRow>(`
      WITH live_personal_orgs AS (
        SELECT workos_organization_id, name
        FROM organizations
        WHERE COALESCE(is_personal, false) = true
          AND subscription_status = 'active'
          AND subscription_canceled_at IS NULL
      )
      SELECT DISTINCT
        po.workos_organization_id AS personal_org_id,
        po.name AS personal_org_name,
        co.workos_organization_id AS company_org_id,
        co.name AS company_org_name,
        pod.domain,
        pod.verified AS domain_verified,
        pom.email AS user_email,
        CASE
          WHEN co.subscription_status = 'active' AND co.subscription_canceled_at IS NULL THEN 'member'
          WHEN co.subscription_status = 'canceled' OR co.subscription_canceled_at IS NOT NULL THEN 'churned'
          ELSE 'prospect'
        END AS company_member_status,
        co.subscription_status AS company_subscription_status
      FROM live_personal_orgs po
      JOIN organization_domains pod
        ON pod.workos_organization_id = po.workos_organization_id
      JOIN organization_memberships pom
        ON pom.workos_organization_id = po.workos_organization_id
       AND pom.email IS NOT NULL
      JOIN organizations co
        ON COALESCE(co.is_personal, false) = false
       AND co.workos_organization_id <> po.workos_organization_id
       AND (
         LOWER(co.email_domain) = LOWER(pod.domain)
         OR EXISTS (
           SELECT 1
           FROM organization_domains cod
           WHERE cod.workos_organization_id = co.workos_organization_id
             AND LOWER(cod.domain) = LOWER(pod.domain)
         )
       )
      JOIN organization_memberships com
        ON com.workos_organization_id = co.workos_organization_id
       AND LOWER(com.email) = LOWER(pom.email)
    `);

    const violations: Violation[] = result.rows.map((row) => ({
      invariant: 'personal-member-company-org-split',
      severity: 'warning',
      subject_type: 'organization',
      subject_id: row.company_org_id,
      message:
        `User ${row.user_email} has active personal workspace "${row.personal_org_name}" ` +
        `holding domain ${row.domain}, while also belonging to company org "${row.company_org_name}". ` +
        'Registry/domain setup may be targeting the personal workspace instead of the company org.',
      details: {
        domain: row.domain,
        domain_verified: row.domain_verified,
        user_email: row.user_email,
        personal_org_id: row.personal_org_id,
        personal_org_name: row.personal_org_name,
        company_org_id: row.company_org_id,
        company_org_name: row.company_org_name,
        company_member_status: row.company_member_status,
        company_subscription_status: row.company_subscription_status,
      },
      remediation_hint:
        `Decide the canonical org for ${row.domain}. If it is ${row.company_org_id}, move/replace the paid membership and domain claim there before registering agents.`,
    }));

    return { checked: result.rows.length, violations };
  },
};
