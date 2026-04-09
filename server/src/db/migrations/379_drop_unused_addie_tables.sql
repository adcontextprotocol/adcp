-- Drop Addie experimentation/analysis infrastructure tables.
-- These features were built but never used in production:
-- - addie_experiments: A/B testing framework, never activated
-- - addie_rule_suggestions: AI-generated rule suggestions, manual-only
-- - addie_analysis_runs: Rule analysis batch tracking, manual-only
-- - addie_eval_runs / addie_eval_results: Eval framework, never populated
--
-- Rules are now served from markdown files in server/src/addie/rules/.
-- The addie_rules table is intentionally kept for historical reference.

DROP INDEX IF EXISTS idx_addie_eval_results_run_id;

DROP TABLE IF EXISTS addie_eval_results;
DROP TABLE IF EXISTS addie_eval_runs;
DROP TABLE IF EXISTS addie_rule_suggestions;
DROP TABLE IF EXISTS addie_analysis_runs;
DROP TABLE IF EXISTS addie_experiments;
