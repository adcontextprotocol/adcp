-- Persist provider-normalized usage in the legacy interaction audit sink.
--
-- The unified thread-message sink already retains these values. Keeping the
-- audit sink aligned prevents provider/model provenance from being separated
-- from its measured usage. Columns remain nullable for local responses,
-- historical rows, and rolling deploys from older application replicas.

ALTER TABLE addie_interactions
  ADD COLUMN IF NOT EXISTS tokens_input INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_output INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_cache_creation INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER;

ALTER TABLE addie_interactions
  ADD CONSTRAINT addie_interactions_usage_nonnegative
    CHECK (
      (tokens_input IS NULL OR tokens_input >= 0)
      AND (tokens_output IS NULL OR tokens_output >= 0)
      AND (tokens_cache_creation IS NULL OR tokens_cache_creation >= 0)
      AND (tokens_cache_read IS NULL OR tokens_cache_read >= 0)
    ) NOT VALID,
  ADD CONSTRAINT addie_interactions_usage_atomic
    CHECK (
      (
        tokens_input IS NULL
        AND tokens_output IS NULL
        AND tokens_cache_creation IS NULL
        AND tokens_cache_read IS NULL
      )
      OR (
        tokens_input IS NOT NULL
        AND tokens_output IS NOT NULL
      )
    ) NOT VALID;

COMMENT ON COLUMN addie_interactions.tokens_input IS
  'Normalized provider input tokens; NULL when provider usage is unavailable or predates usage persistence.';
COMMENT ON COLUMN addie_interactions.tokens_output IS
  'Normalized provider output tokens; NULL when provider usage is unavailable or predates usage persistence.';
COMMENT ON COLUMN addie_interactions.tokens_cache_creation IS
  'Normalized provider cache-write tokens when reported; NULL means unavailable, not zero.';
COMMENT ON COLUMN addie_interactions.tokens_cache_read IS
  'Normalized provider cache-read tokens when reported; NULL means unavailable, not zero.';
