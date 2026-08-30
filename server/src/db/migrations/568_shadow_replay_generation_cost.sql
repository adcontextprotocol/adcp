-- Record complete, reproducible latency and cost evidence for each newly
-- completed full-response shadow generation. Existing rows remain explicitly
-- unpriced because their cache usage and generation-only latency were not kept.

ALTER TABLE addie_shadow_replay_generations
  ADD COLUMN pricing_version VARCHAR(64) NOT NULL DEFAULT 'legacy-unrecorded',
  ADD COLUMN usage_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_write_tokens >= 0),
  ADD COLUMN latency_ms INTEGER CHECK (latency_ms BETWEEN 0 AND 900000),
  ADD COLUMN estimated_cost_micros BIGINT
    CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  ADD CONSTRAINT shadow_replay_generation_pricing_version_valid
    CHECK (pricing_version ~ '^[a-zA-Z0-9._:-]{1,64}$'),
  ADD CONSTRAINT shadow_replay_generation_cost_completeness CHECK (
    (usage_complete AND latency_ms IS NOT NULL AND estimated_cost_micros IS NOT NULL)
    OR
    (NOT usage_complete AND estimated_cost_micros IS NULL)
  ),
  ADD CONSTRAINT shadow_replay_generation_new_usage_consistency CHECK (
    pricing_version = 'legacy-unrecorded'
    OR usage_complete
    OR (
      input_tokens = 0 AND output_tokens = 0
      AND cache_read_tokens = 0 AND cache_write_tokens = 0
    )
  ),
  ADD CONSTRAINT shadow_replay_generation_new_success_evidence CHECK (
    pricing_version = 'legacy-unrecorded'
    OR status <> 'succeeded'
    OR usage_complete
  );

COMMENT ON COLUMN addie_shadow_replay_generations.pricing_version IS
  'Immutable reviewed price-table version selected before the provider call';
COMMENT ON COLUMN addie_shadow_replay_generations.usage_complete IS
  'True only when normalized terminal usage was returned; false is not equivalent to zero usage';
COMMENT ON COLUMN addie_shadow_replay_generations.latency_ms IS
  'Generation-only monotonic wall time, excluding any later independent judgment';
COMMENT ON COLUMN addie_shadow_replay_generations.estimated_cost_micros IS
  'Cost computed from complete token/cache usage and the persisted pricing version';
