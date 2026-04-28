-- One-time backfill: users.primary_organization_id from organization_memberships.
--
-- The column is a denormalized pointer set by the organization_membership.created
-- webhook and by enrichUserWithMembership on page load. A user.created /
-- membership.created webhook-order race or a fire-and-forget backfill failure
-- can leave the column NULL even when the user has memberships. Every read
-- site that doesn't fall back from the column to organization_memberships
-- silently treats those users as "no organization" — that's the bug that
-- broke directory listings for paid Founding members in April 2026.
--
-- Ongoing prevention: users-db.ts:resolvePrimaryOrganization (centralized
-- read-with-fallback), upsertUser webhook backfill, and the
-- users-have-primary-organization integrity invariant.
--
-- Scale: single statement is fine at current users-table size (low thousands
-- as of this commit). If the table grows past ~100k rows, batch via
-- WHERE workos_user_id IN (... LIMIT 5000) loops to avoid holding row locks
-- across the whole table in one transaction.

UPDATE users u
SET primary_organization_id = pref.org_id,
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (om.workos_user_id)
    om.workos_user_id,
    om.workos_organization_id AS org_id
  FROM organization_memberships om
  JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
  ORDER BY
    om.workos_user_id,
    CASE WHEN o.subscription_status = 'active' THEN 0 ELSE 1 END,
    om.created_at DESC
) pref
WHERE u.workos_user_id = pref.workos_user_id
  AND u.primary_organization_id IS NULL;
