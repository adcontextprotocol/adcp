-- Persist the authorization graph version for every identity. Authentication
-- caches compare this value on every request so a credential link/unlink,
-- primary change, or organization-membership mutation cannot leave stale
-- authority alive until an in-memory TTL expires.

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS authorization_epoch BIGINT NOT NULL DEFAULT 1;

-- Credential-local epoch serializes authority changes with binding moves.
-- Identity epochs alone are insufficient because a membership/grant trigger
-- can race an unlink and bump the identity the credential just left.
ALTER TABLE identity_workos_users
  ADD COLUMN IF NOT EXISTS authorization_epoch BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_identity_binding_authorization_epoch()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE identities
       SET authorization_epoch = authorization_epoch + 1
     WHERE id = NEW.identity_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE identities
       SET authorization_epoch = authorization_epoch + 1
     WHERE id = OLD.identity_id;
  ELSE
    UPDATE identities
       SET authorization_epoch = authorization_epoch + 1
     WHERE id IN (OLD.identity_id, NEW.identity_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_binding_authorization_epoch
  ON identity_workos_users;
CREATE TRIGGER trg_identity_binding_authorization_epoch
AFTER INSERT OR UPDATE OR DELETE ON identity_workos_users
FOR EACH ROW EXECUTE FUNCTION bump_identity_binding_authorization_epoch();

CREATE OR REPLACE FUNCTION bump_membership_authorization_epoch()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id = NEW.workos_user_id;
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT iwu.identity_id
         FROM identity_workos_users iwu
        WHERE iwu.workos_user_id = NEW.workos_user_id
     );
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id = OLD.workos_user_id;
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT iwu.identity_id
         FROM identity_workos_users iwu
        WHERE iwu.workos_user_id = OLD.workos_user_id
     );
  ELSIF OLD.workos_user_id IS DISTINCT FROM NEW.workos_user_id
     OR OLD.workos_organization_id IS DISTINCT FROM NEW.workos_organization_id
     OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.seat_type IS DISTINCT FROM NEW.seat_type THEN
    UPDATE identity_workos_users
       SET authorization_epoch = authorization_epoch + 1
     WHERE workos_user_id IN (OLD.workos_user_id, NEW.workos_user_id);
    UPDATE identities i
       SET authorization_epoch = i.authorization_epoch + 1
     WHERE i.id IN (
       SELECT iwu.identity_id
         FROM identity_workos_users iwu
        WHERE iwu.workos_user_id IN (OLD.workos_user_id, NEW.workos_user_id)
     );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_membership_authorization_epoch
  ON organization_memberships;
CREATE TRIGGER trg_membership_authorization_epoch
AFTER INSERT OR UPDATE OR DELETE ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION bump_membership_authorization_epoch();

COMMENT ON COLUMN identities.authorization_epoch IS
  'Monotonic version checked by cached sessions; bumped by credential-binding and organization-membership changes';

COMMENT ON COLUMN identity_workos_users.authorization_epoch IS
  'Credential-local authorization version; row locking serializes membership and grant revocation with binding moves';
