-- Release gates for the AdCP 3.1 S2 Creative canonical-formats delta.
--
-- Both dates must be configured before learner targeting, status display, or
-- delta assessment entry points become active. Updates should go through
-- system_settings helpers so system_settings_audit records who enabled them.

INSERT INTO system_settings (key, value, description)
VALUES (
  'certification_s2_canonical_formats_delta_release',
  '{"adcp_3_1_ga_at": null, "criteria_deployed_at": null}'::jsonb,
  'Release gates for the S2 canonical-formats delta: AdCP 3.1.0 GA and production deployment of migration 496_curriculum_3_1_canonical_formats_criteria.sql'
)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS learner_protocol_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  update_id TEXT NOT NULL,
  module_id VARCHAR(10) NOT NULL REFERENCES certification_modules(id),
  credential_id VARCHAR(50) NOT NULL REFERENCES certification_credentials(id),
  attempt_id UUID REFERENCES certification_attempts(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criterion_ids TEXT[] NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workos_user_id, update_id)
);

CREATE INDEX IF NOT EXISTS idx_learner_protocol_updates_update
  ON learner_protocol_updates(update_id, completed_at DESC);

COMMENT ON TABLE learner_protocol_updates IS
  'Auditable protocol-change update completions, including targeted recertification deltas.';
COMMENT ON COLUMN learner_protocol_updates.update_id IS
  'Stable update identifier, e.g. s2_canonical_formats_3_1.';
COMMENT ON COLUMN learner_protocol_updates.evidence IS
  'Criterion-id keyed evidence retained for accreditation audit trails.';
