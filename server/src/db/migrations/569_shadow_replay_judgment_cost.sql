-- Give independent-judge promotion evidence the same reproducible pricing,
-- usage-completeness, cache, and monotonic-latency contract as generation.
-- Existing rows remain explicitly unpriced.

ALTER TABLE addie_shadow_replay_judgments
  ADD COLUMN pricing_version VARCHAR(64) NOT NULL DEFAULT 'legacy-unrecorded',
  ADD COLUMN usage_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_write_tokens >= 0),
  ADD COLUMN latency_ms INTEGER CHECK (latency_ms BETWEEN 0 AND 900000),
  ADD COLUMN estimated_cost_micros BIGINT
    CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  ADD CONSTRAINT shadow_replay_judgment_pricing_version_valid
    CHECK (pricing_version ~ '^[a-zA-Z0-9._:-]{1,64}$'),
  ADD CONSTRAINT shadow_replay_judgment_cost_completeness CHECK (
    (usage_complete AND estimated_cost_micros IS NOT NULL)
    OR
    (NOT usage_complete AND estimated_cost_micros IS NULL)
  ),
  ADD CONSTRAINT shadow_replay_judgment_new_usage_consistency CHECK (
    pricing_version = 'legacy-unrecorded'
    OR usage_complete
    OR (
      input_tokens = 0 AND output_tokens = 0
      AND cache_read_tokens = 0 AND cache_write_tokens = 0
    )
  ),
  ADD CONSTRAINT shadow_replay_judgment_new_execution_consistency CHECK (
    pricing_version = 'legacy-unrecorded'
    OR (
      judge_model IS NULL
      AND pricing_version = 'not-applicable'
      AND NOT usage_complete
      AND latency_ms IS NULL
      AND estimated_cost_micros IS NULL
    )
    OR (
      judge_model IS NOT NULL
      AND pricing_version <> 'not-applicable'
    )
  ),
  ADD CONSTRAINT shadow_replay_judgment_new_success_evidence CHECK (
    pricing_version = 'legacy-unrecorded'
    OR status <> 'judged'
    OR (usage_complete AND latency_ms IS NOT NULL)
  );

COMMENT ON COLUMN addie_shadow_replay_judgments.pricing_version IS
  'Reviewed price-table version used for the judge call, or not-applicable when no call ran';
COMMENT ON COLUMN addie_shadow_replay_judgments.usage_complete IS
  'True only when normalized terminal judge usage was returned; false is not zero usage';
COMMENT ON COLUMN addie_shadow_replay_judgments.latency_ms IS
  'Monotonic provider-call time only, excluding deterministic grading and persistence';
COMMENT ON COLUMN addie_shadow_replay_judgments.estimated_cost_micros IS
  'Judge cost computed from complete token/cache usage and the persisted pricing version';
