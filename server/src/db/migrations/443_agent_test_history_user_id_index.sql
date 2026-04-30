-- Add a covering index for getLatestTestForUser, called on every Addie
-- member-context hydration (Slack and web flows) by the agent-test
-- staleness prompt rule. Without this index the query falls back to
-- the agent_context_id index + filter, which is fine for small data
-- but degrades as agent_test_history grows.

CREATE INDEX IF NOT EXISTS idx_agent_test_history_user_started
  ON agent_test_history(user_id, started_at DESC);
