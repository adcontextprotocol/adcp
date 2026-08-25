-- Organization-approved authority for one exact WorkOS credential, without
-- copying a different credential's organization membership. This migration is
-- deliberately schema-only: no production authorization path reads it until
-- the separately gated enforcement canary is enabled.

CREATE TABLE IF NOT EXISTS organization_credential_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id VARCHAR(255) NOT NULL
    REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  workos_user_id VARCHAR(255) NOT NULL
    REFERENCES users(workos_user_id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin', 'owner')),
  granted_by_workos_user_id VARCHAR(255) NOT NULL,
  reason TEXT,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_workos_user_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (revoked_at IS NULL OR revoked_by_workos_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_organization_credential_grants_active
  ON organization_credential_grants (workos_user_id, workos_organization_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_credential_grants_one_active
  ON organization_credential_grants (workos_organization_id, workos_user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE organization_credential_grants IS
  'Organization-approved authority for one exact credential; never inherited through identity linkage';
