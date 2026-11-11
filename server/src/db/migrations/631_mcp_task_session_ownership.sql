-- PostgresTaskStore now records caller ownership on every task insert.
-- Migration 383 predates that SDK change; CREATE TABLE IF NOT EXISTS cannot
-- upgrade an existing table. Keep legacy rows unowned rather than assigning
-- them to a caller, matching @adcp/sdk getMcpTasksMigration().
ALTER TABLE adcp_mcp_tasks ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_adcp_mcp_tasks_session_created_at
  ON adcp_mcp_tasks(session_id, created_at, task_id);
