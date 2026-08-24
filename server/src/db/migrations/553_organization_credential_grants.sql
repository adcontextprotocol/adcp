-- Organization-approved authority for an exact WorkOS credential without
-- copying another credential's WorkOS membership. The row is durable
-- provenance: revocation updates it rather than deleting/re-parenting it.

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

CREATE OR REPLACE FUNCTION bump_credential_grant_authorization_epoch()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id = NEW.workos_user_id;
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id = NEW.workos_user_id
     );
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id = OLD.workos_user_id;
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id = OLD.workos_user_id
     );
  ELSIF OLD.workos_user_id IS DISTINCT FROM NEW.workos_user_id
     OR OLD.workos_organization_id IS DISTINCT FROM NEW.workos_organization_id
     OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
     OR OLD.effective_until IS DISTINCT FROM NEW.effective_until
     OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id IN (OLD.workos_user_id, NEW.workos_user_id);
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id IN (OLD.workos_user_id, NEW.workos_user_id)
     );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credential_grant_authorization_epoch
  ON organization_credential_grants;
CREATE TRIGGER trg_credential_grant_authorization_epoch
AFTER INSERT OR UPDATE OR DELETE ON organization_credential_grants
FOR EACH ROW EXECUTE FUNCTION bump_credential_grant_authorization_epoch();

COMMENT ON TABLE organization_credential_grants IS
  'Organization-approved authority for one exact credential; never inherited through identity linkage';
