-- Link synthesis runs to config versions
-- Tracks which config version resulted from applying a synthesis run

-- Add column to synthesis_runs to track resulting config version
ALTER TABLE addie_synthesis_runs
  ADD COLUMN IF NOT EXISTS resulting_config_version_id INTEGER REFERENCES addie_config_versions(version_id);

-- Add column to config_versions to track what synthesis run(s) contributed
ALTER TABLE addie_config_versions
  ADD COLUMN IF NOT EXISTS source_synthesis_run_ids INTEGER[];

-- Index for finding config versions from synthesis
CREATE INDEX IF NOT EXISTS idx_config_versions_synthesis
  ON addie_config_versions(source_synthesis_run_ids)
  WHERE source_synthesis_run_ids IS NOT NULL;

-- View for current Addie configuration status
CREATE OR REPLACE VIEW addie_current_config AS
SELECT
  cv.version_id,
  cv.config_hash,
  cv.created_at,
  array_length(cv.active_rule_ids, 1) as rule_count,
  cv.message_count,
  cv.positive_feedback,
  cv.negative_feedback,
  cv.avg_rating,
  cv.source_synthesis_run_ids,
  -- Get rule names for display
  (
    SELECT array_agg(name ORDER BY priority DESC)
    FROM addie_rules
    WHERE id = ANY(cv.active_rule_ids) AND is_active = true
  ) as active_rule_names,
  -- Count rules by type
  (
    SELECT jsonb_object_agg(rule_type, cnt)
    FROM (
      SELECT rule_type, COUNT(*) as cnt
      FROM addie_rules
      WHERE id = ANY(cv.active_rule_ids) AND is_active = true
      GROUP BY rule_type
    ) type_counts
  ) as rules_by_type
FROM addie_config_versions cv
WHERE cv.version_id = (
  SELECT MAX(version_id) FROM addie_config_versions
);

COMMENT ON COLUMN addie_synthesis_runs.resulting_config_version_id IS 'Config version ID created when this synthesis was applied';
COMMENT ON COLUMN addie_config_versions.source_synthesis_run_ids IS 'Synthesis run IDs that contributed rules to this config version';
