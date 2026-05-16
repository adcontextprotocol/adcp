-- Backfill organizations.email_domain from organization_domains.
--
-- Why: prospect/sales-discovered orgs created via routes/admin/domains.ts
-- and OrganizationDatabase.createOrganization were inserted with
-- email_domain NULL. The column was meant to be filled by the WorkOS
-- `organization.updated` webhook, but if that webhook never fires (or
-- fires before the row is committed) the column stays NULL forever and
-- later @domain signups can never auto-link to the org.
--
-- This migration mirrors the canonical domain from organization_domains:
--   1) prefer is_primary = true
--   2) then verified = true
--   3) then any row, oldest first
-- Only applies to non-personal orgs (personal-tier email_domain is
-- intentionally NULL — see workos-webhooks.ts:587-596).
--
-- Idempotent: only updates rows where email_domain IS NULL or ''.

UPDATE organizations o
SET
  email_domain = chosen.domain,
  updated_at = NOW()
FROM (
  SELECT DISTINCT ON (od.workos_organization_id)
    od.workos_organization_id,
    LOWER(od.domain) AS domain
  FROM organization_domains od
  ORDER BY
    od.workos_organization_id,
    od.is_primary DESC,
    od.verified DESC,
    od.created_at ASC
) AS chosen
WHERE o.workos_organization_id = chosen.workos_organization_id
  AND o.is_personal = FALSE
  AND (o.email_domain IS NULL OR o.email_domain = '');
