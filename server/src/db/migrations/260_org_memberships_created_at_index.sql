-- Index to support LATERAL join that picks the earliest member per org
-- Used by list_paying_members to find primary contact efficiently
CREATE INDEX IF NOT EXISTS idx_organization_memberships_org_created
  ON organization_memberships(workos_organization_id, created_at ASC);
