-- Add code_version column to track Addie code changes
-- This is a manually-bumped version string for significant code logic changes

ALTER TABLE addie_config_versions
  ADD COLUMN IF NOT EXISTS code_version VARCHAR(32);

-- Index for filtering by code version
CREATE INDEX IF NOT EXISTS idx_addie_config_versions_code_version
  ON addie_config_versions(code_version)
  WHERE code_version IS NOT NULL;

COMMENT ON COLUMN addie_config_versions.code_version IS 'Manually-bumped version string tracking significant code logic changes';
