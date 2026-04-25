-- Drop addie_rules table. Rules migrated to server/src/addie/rules/*.md in PR #2028.
-- The addie_current_config view references addie_rules and must be dropped first.
-- active_rule_ids columns in addie_config_versions and addie_thread_messages are plain
-- INTEGER[] arrays with no FK constraint; they stay as historical metadata.

DROP VIEW IF EXISTS addie_current_config;
DROP TABLE IF EXISTS addie_rules;
