-- Drop addie_rules table. Rules migrated to server/src/addie/rules/*.md in PR #2028.
-- Dependents that must be resolved before the table drop:
--   1. addie_current_config VIEW (migration 163) — references addie_rules directly
--   2. addie_insight_sources.resulting_rule_id FK (migration 162) — FK → addie_rules(id)
-- active_rule_ids columns in addie_config_versions and addie_thread_messages are plain
-- INTEGER[] arrays with no FK constraint; they stay as historical metadata.

DROP VIEW IF EXISTS addie_current_config;
ALTER TABLE IF EXISTS addie_insight_sources
  DROP CONSTRAINT IF EXISTS addie_insight_sources_resulting_rule_id_fkey;
DROP TABLE IF EXISTS addie_rules;
