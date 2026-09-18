-- Drain old application workers before applying this migration. An old
-- in-memory claim must not survive the authenticated-credential boundary.
LOCK TABLE agent_compliance_refresh_requests IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Compliance refresh credential migration requires READ COMMITTED';
  END IF;
  IF EXISTS (SELECT 1 FROM agent_compliance_refresh_requests WHERE status = 'running') THEN
    RAISE EXCEPTION 'Drain all running compliance refresh requests before applying migration 599';
  END IF;
END $$;

-- Existing requester IDs can be canonical linked IDs. Sentinels record that
-- provenance is unknown; no credential or authorization epoch is backfilled.
ALTER TABLE agent_compliance_refresh_requests
  ADD COLUMN requested_by_auth_workos_user_id TEXT NOT NULL DEFAULT '__unproven__',
  ADD COLUMN authorization_fingerprint TEXT NOT NULL DEFAULT '__unproven__';

ALTER TABLE agent_compliance_refresh_requests
  ALTER COLUMN requested_by_auth_workos_user_id DROP DEFAULT,
  ALTER COLUMN authorization_fingerprint DROP DEFAULT;

UPDATE agent_compliance_refresh_requests
   SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
       result_json = NULL,
       last_error_code = 'authorization_provenance_missing',
       last_error = 'Authenticated credential provenance is missing; submit a new refresh'
 WHERE status = 'queued';

ALTER TABLE agent_compliance_refresh_requests
  ADD CONSTRAINT agent_compliance_refresh_authenticated_credential CHECK (
    (
      requested_by_auth_workos_user_id = '__unproven__'
      AND authorization_fingerprint = '__unproven__'
      AND status IN ('succeeded', 'failed')
    ) OR (
      requester_type = 'user'
      AND requested_by_auth_workos_user_id <> '__unproven__'
      AND requested_by_auth_workos_user_id = requested_by_user_id
      AND char_length(requested_by_auth_workos_user_id) > 0
      AND requested_by_auth_workos_user_id = btrim(requested_by_auth_workos_user_id)
      AND (
        authorization_fingerprint = ''
        OR (
          left(authorization_fingerprint, char_length(requested_by_auth_workos_user_id) + 1)
            = requested_by_auth_workos_user_id || ':'
          AND substring(authorization_fingerprint FROM char_length(requested_by_auth_workos_user_id) + 2)
            ~ '^[1-9][0-9]{0,18}$'
          AND (
            char_length(substring(authorization_fingerprint FROM char_length(requested_by_auth_workos_user_id) + 2)) < 19
            OR substring(authorization_fingerprint FROM char_length(requested_by_auth_workos_user_id) + 2) COLLATE "C"
              <= '9223372036854775807' COLLATE "C"
          )
        )
      )
    )
  );

CREATE FUNCTION guard_compliance_refresh_authenticated_credential()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requester_type <> 'user' OR NEW.status <> 'queued'
      OR NEW.requested_by_auth_workos_user_id = '__unproven__'
      OR NEW.authorization_fingerprint = '__unproven__' THEN
      RAISE EXCEPTION 'New compliance refresh requests require authenticated user provenance';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.agent_url, NEW.owner_org_id, NEW.requester_type,
           NEW.requested_by_user_id, NEW.requested_by_auth_workos_user_id,
           NEW.authorization_fingerprint, NEW.triggered_by, NEW.test_session_id)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.agent_url, OLD.owner_org_id, OLD.requester_type,
           OLD.requested_by_user_id, OLD.requested_by_auth_workos_user_id,
           OLD.authorization_fingerprint, OLD.triggered_by, OLD.test_session_id) THEN
      RAISE EXCEPTION 'Compliance refresh authenticated provenance is immutable';
    END IF;
    -- Old binaries preserve new columns in UPDATEs, so NOT NULL alone does
    -- not prevent them from claiming a request admitted by a new instance.
    IF NEW.status = 'running'
      AND (OLD.status <> 'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token)
      AND current_setting('adcp.compliance_refresh_writer_contract', true)
        IS DISTINCT FROM 'authenticated-credential-v1' THEN
      RAISE EXCEPTION 'Compliance refresh claims require the authenticated-credential worker contract';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_compliance_refresh_authenticated_credential
  BEFORE INSERT OR UPDATE ON agent_compliance_refresh_requests
  FOR EACH ROW EXECUTE FUNCTION guard_compliance_refresh_authenticated_credential();

COMMENT ON COLUMN agent_compliance_refresh_requests.requested_by_auth_workos_user_id IS
  'Exact authenticated WorkOS credential. __unproven__ marks historical requests that cannot execute or coalesce.';
COMMENT ON COLUMN agent_compliance_refresh_requests.authorization_fingerprint IS
  'Immutable exact-credential authorization epoch at admission: empty if unbumped, credential:epoch otherwise. __unproven__ is historical only.';
