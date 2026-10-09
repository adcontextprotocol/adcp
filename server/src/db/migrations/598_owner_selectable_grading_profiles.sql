BEGIN;

CREATE TABLE verification_profile_role_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id UUID NOT NULL REFERENCES agent_compliance_runs(id) ON DELETE RESTRICT,
  agent_url TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence'
  )),
  adcp_version TEXT NOT NULL CHECK (adcp_version ~ '^[1-9][0-9]*\.[0-9]+$'),
  grading_profile TEXT NOT NULL CHECK (grading_profile IN ('legacy', 'spec', 'sandbox')),
  status TEXT CHECK (status IS NULL OR status IN ('passing', 'partial', 'failing')),
  selectable BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version VARCHAR(64) NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 64),
  compliance_bundle_version TEXT NOT NULL,
  requested_compliance_target TEXT,
  lifecycle_stage TEXT NOT NULL CHECK (
    lifecycle_stage IN ('development', 'testing', 'production', 'deprecated')
  ),
  run_complete BOOLEAN NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_tested_at TIMESTAMPTZ NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_run_id, role, adcp_version, grading_profile, policy_version),
  UNIQUE (id, agent_url, role, adcp_version, grading_profile),
  UNIQUE (
    id, agent_url, role, adcp_version, grading_profile,
    source_run_id, policy_version, compliance_bundle_version
  ),
  CHECK (grading_profile <> 'sandbox' OR selectable = FALSE),
  CHECK (grading_profile = 'sandbox' OR status IS NOT NULL)
);

CREATE INDEX verification_profile_role_assessments_latest
  ON verification_profile_role_assessments(agent_url, role, adcp_version, source_tested_at DESC);

COMMENT ON TABLE verification_profile_role_assessments IS
  'Immutable exact badge-identity grading evidence. Sandbox rows are comparison-only and cannot be selected.';

-- The source run is the authority for every provenance field carried by an
-- assessment. A UUID-only FK would still allow a caller with direct SQL access
-- (or a future application bug) to pair a real run with another agent,
-- lifecycle, target, or bundle version. Normalize the timestamp from the row
-- itself because node-postgres transports Date values at millisecond precision
-- while PostgreSQL timestamps can retain microseconds.
CREATE OR REPLACE FUNCTION validate_verification_profile_assessment_source()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  source agent_compliance_runs%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM agent_compliance_runs
  WHERE id = NEW.source_run_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification profile assessment source run does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF source.agent_url IS DISTINCT FROM NEW.agent_url
     OR source.lifecycle_stage IS DISTINCT FROM NEW.lifecycle_stage
     OR source.adcp_version IS DISTINCT FROM NEW.compliance_bundle_version
     OR source.requested_compliance_target IS DISTINCT FROM NEW.requested_compliance_target
     OR source.dry_run IS DISTINCT FROM FALSE
     OR source.is_authoritative IS DISTINCT FROM TRUE
     OR source.completeness IS DISTINCT FROM 'complete'
     OR NEW.run_complete IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'verification profile assessment provenance does not match an authoritative complete source run'
      USING ERRCODE = '23514';
  END IF;

  NEW.source_tested_at := source.tested_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER verification_profile_role_assessments_source_guard
  BEFORE INSERT ON verification_profile_role_assessments
  FOR EACH ROW EXECUTE FUNCTION validate_verification_profile_assessment_source();

-- Once a source run has role assessments, its load-bearing provenance is
-- immutable as well. ON DELETE RESTRICT protects deletion; this trigger closes
-- the update path for fields used by selection and audit.
CREATE OR REPLACE FUNCTION reject_assessed_compliance_run_provenance_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM verification_profile_role_assessments
    WHERE source_run_id = OLD.id
  ) AND (
    OLD.agent_url IS DISTINCT FROM NEW.agent_url
    OR OLD.lifecycle_stage IS DISTINCT FROM NEW.lifecycle_stage
    OR OLD.adcp_version IS DISTINCT FROM NEW.adcp_version
    OR OLD.requested_compliance_target IS DISTINCT FROM NEW.requested_compliance_target
    OR OLD.tested_at IS DISTINCT FROM NEW.tested_at
    OR OLD.dry_run IS DISTINCT FROM NEW.dry_run
    OR OLD.is_authoritative IS DISTINCT FROM NEW.is_authoritative
    OR OLD.completeness IS DISTINCT FROM NEW.completeness
  ) THEN
    RAISE EXCEPTION 'assessed compliance run provenance is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assessed_compliance_run_provenance_immutable
  BEFORE UPDATE ON agent_compliance_runs
  FOR EACH ROW EXECUTE FUNCTION reject_assessed_compliance_run_provenance_mutation();

CREATE OR REPLACE FUNCTION reject_verification_profile_assessment_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verification profile assessments are immutable';
END;
$$;

CREATE TRIGGER verification_profile_role_assessments_immutable
  BEFORE UPDATE OR DELETE ON verification_profile_role_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_verification_profile_assessment_mutation();

CREATE TABLE agent_grading_profiles (
  agent_url TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence'
  )),
  adcp_version TEXT NOT NULL CHECK (adcp_version ~ '^[1-9][0-9]*\.[0-9]+$'),
  selected_profile TEXT NOT NULL CHECK (selected_profile IN ('legacy', 'spec')),
  selected_assessment_id UUID NOT NULL REFERENCES verification_profile_role_assessments(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL CHECK (revision > 0),
  spec_failure_since TIMESTAMPTZ,
  selected_by_user_id TEXT NOT NULL,
  selected_by_org_id TEXT NOT NULL,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_url, role, adcp_version),
  CONSTRAINT agent_grading_profiles_assessment_identity_fk
    FOREIGN KEY (
      selected_assessment_id, agent_url, role, adcp_version, selected_profile
    ) REFERENCES verification_profile_role_assessments (
      id, agent_url, role, adcp_version, grading_profile
    ) ON DELETE RESTRICT
);

-- Stable request identity for idempotency replay. request_id and resulting
-- public effects are intentionally excluded: they can differ on a transport
-- retry, while every caller-controlled mutation field must remain identical.
CREATE OR REPLACE FUNCTION grading_profile_request_fingerprint(
  p_actor_user_id TEXT,
  p_actor_org_id TEXT,
  p_actor_kind TEXT,
  p_admin_override_reason TEXT,
  p_agent_url TEXT,
  p_role TEXT,
  p_adcp_version TEXT,
  p_selected_profile TEXT,
  p_assessment_id UUID,
  p_expected_revision BIGINT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    length(p_actor_user_id)::text || ':' || p_actor_user_id ||
    length(p_actor_org_id)::text || ':' || p_actor_org_id ||
    length(p_actor_kind)::text || ':' || p_actor_kind ||
    length(COALESCE(p_admin_override_reason, ''))::text || ':' || COALESCE(p_admin_override_reason, '') ||
    length(p_agent_url)::text || ':' || p_agent_url ||
    length(p_role)::text || ':' || p_role ||
    length(p_adcp_version)::text || ':' || p_adcp_version ||
    length(p_selected_profile)::text || ':' || p_selected_profile ||
    length(p_assessment_id::text)::text || ':' || p_assessment_id::text ||
    length(p_expected_revision::text)::text || ':' || p_expected_revision::text
$$;

CREATE TABLE agent_grading_profile_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_org_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('organization', 'registry_admin')),
  admin_override_reason TEXT,
  agent_url TEXT NOT NULL,
  role TEXT NOT NULL,
  adcp_version TEXT NOT NULL,
  previous_profile TEXT NOT NULL CHECK (previous_profile IN ('legacy', 'spec')),
  selected_profile TEXT NOT NULL CHECK (selected_profile IN ('legacy', 'spec')),
  previous_revision BIGINT NOT NULL CHECK (previous_revision >= 0),
  selected_revision BIGINT NOT NULL CHECK (selected_revision > 0),
  assessment_id UUID NOT NULL REFERENCES verification_profile_role_assessments(id) ON DELETE RESTRICT,
  source_run_id UUID NOT NULL REFERENCES agent_compliance_runs(id) ON DELETE RESTRICT,
  policy_version VARCHAR(64) NOT NULL,
  compliance_bundle_version TEXT NOT NULL,
  predicted_public_effect TEXT NOT NULL CHECK (
    predicted_public_effect IN ('unchanged', 'issue', 'restore', 'degrade', 'revoke', 'regrade')
  ),
  actual_public_effect TEXT NOT NULL CHECK (
    actual_public_effect IN ('unchanged', 'issue', 'restore', 'degrade', 'revoke', 'regrade')
  ),
  request_fingerprint TEXT GENERATED ALWAYS AS (
    grading_profile_request_fingerprint(
      actor_user_id, actor_org_id, actor_kind, admin_override_reason,
      agent_url, role, adcp_version, selected_profile, assessment_id,
      previous_revision
    )
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_grading_profile_audit_assessment_provenance_fk
    FOREIGN KEY (
      assessment_id, agent_url, role, adcp_version, selected_profile,
      source_run_id, policy_version, compliance_bundle_version
    ) REFERENCES verification_profile_role_assessments (
      id, agent_url, role, adcp_version, grading_profile,
      source_run_id, policy_version, compliance_bundle_version
    ) ON DELETE RESTRICT,
  UNIQUE (
    agent_url, role, adcp_version, selected_revision, source_run_id, assessment_id
  )
);

CREATE INDEX agent_grading_profile_audit_identity
  ON agent_grading_profile_audit(agent_url, role, adcp_version, created_at DESC);

COMMENT ON TABLE agent_grading_profile_audit IS
  'Append-only audit of owner/admin grading-profile decisions and their immediate public projection.';

CREATE OR REPLACE FUNCTION reject_grading_profile_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grading profile audit rows are append-only';
END;
$$;

CREATE TRIGGER agent_grading_profile_audit_append_only
  BEFORE UPDATE OR DELETE ON agent_grading_profile_audit
  FOR EACH ROW EXECUTE FUNCTION reject_grading_profile_audit_mutation();

CREATE TABLE agent_grading_profile_projection_jobs (
  agent_url TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence'
  )),
  adcp_version TEXT NOT NULL CHECK (adcp_version ~ '^[1-9][0-9]*\.[0-9]+$'),
  selection_revision BIGINT NOT NULL CHECK (selection_revision > 0),
  source_run_id UUID NOT NULL REFERENCES agent_compliance_runs(id) ON DELETE RESTRICT,
  assessment_id UUID NOT NULL REFERENCES verification_profile_role_assessments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_url, role, adcp_version, selection_revision),
  CONSTRAINT agent_grading_profile_projection_jobs_audit_fk
    FOREIGN KEY (
      agent_url, role, adcp_version, selection_revision, source_run_id, assessment_id
    ) REFERENCES agent_grading_profile_audit (
      agent_url, role, adcp_version, selected_revision, source_run_id, assessment_id
    ) ON DELETE RESTRICT
);

CREATE INDEX agent_grading_profile_projection_jobs_due
  ON agent_grading_profile_projection_jobs(next_attempt_at)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE agent_grading_profile_projection_jobs IS
  'Durable exact-role badge/token projection retries. Workers use immutable stored compliance evidence and never contact the agent.';

ALTER TABLE agent_verification_badges
  ADD COLUMN grading_profile TEXT NOT NULL DEFAULT 'legacy'
    CHECK (grading_profile IN ('legacy', 'spec')),
  ADD COLUMN grading_policy_version VARCHAR(64),
  ADD COLUMN grading_source_run_id UUID REFERENCES agent_compliance_runs(id) ON DELETE SET NULL,
  ADD COLUMN grading_assessment_id UUID REFERENCES verification_profile_role_assessments(id) ON DELETE SET NULL,
  ADD COLUMN grading_profile_revision BIGINT NOT NULL DEFAULT 0 CHECK (grading_profile_revision >= 0),
  ADD COLUMN degraded_at TIMESTAMPTZ;

UPDATE agent_verification_badges
SET degraded_at = updated_at
WHERE status = 'degraded' AND degraded_at IS NULL;

WITH inserted AS (
  INSERT INTO system_settings (key, value, description)
  VALUES (
    'grading_profile_rollout',
    '{"selection_enabled": true, "legacy_selection_allowed_until": null}'::jsonb,
    'Owner-selectable exact role/version grading. A null Legacy deadline never auto-migrates existing selections.'
  )
  ON CONFLICT (key) DO NOTHING
  RETURNING value
)
INSERT INTO system_settings_audit (key, old_value, new_value, changed_by, changed_at)
SELECT 'grading_profile_rollout', NULL, value, 'migration-598', NOW()
FROM inserted;

COMMIT;
