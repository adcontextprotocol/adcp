-- Persist the runner's explanation of a storyboard-level verdict
-- (adcp#8576). A storyboard can fail with every visible step passing --
-- a storyboard-scoped invariant, a required phase that never executed, an
-- unmet controller prerequisite, or a runner error -- and the drill-down
-- showed only "storyboard-level verdict failed".

ALTER TABLE agent_storyboard_status
  ADD COLUMN IF NOT EXISTS verdict_explanation_jsonb JSONB;

COMMENT ON COLUMN agent_storyboard_status.verdict_explanation_jsonb IS
  'Runner verdict_reason code, redacted verdict_detail, and up to 10 contributing steps/assertions/phases for a storyboard-level verdict. Owner-scoped in public API responses.';
