-- Per-storyboard compliance status, materialized from compliance runs.
-- One row per (agent_url, storyboard_id). Upserted atomically inside
-- recordComplianceRun() so storyboard status stays consistent with run data.

CREATE TABLE IF NOT EXISTS agent_storyboard_status (
  agent_url       TEXT NOT NULL,
  storyboard_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'untested',
  last_tested_at  TIMESTAMPTZ,
  last_passed_at  TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ,
  run_id          UUID,          -- no FK: compliance_runs are pruned by retention policy
  steps_passed    INTEGER NOT NULL DEFAULT 0,
  steps_total     INTEGER NOT NULL DEFAULT 0,
  triggered_by    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (agent_url, storyboard_id),

  CONSTRAINT valid_storyboard_status CHECK (
    status IN ('passing', 'failing', 'partial', 'untested')
  ),
  CONSTRAINT valid_storyboard_triggered_by CHECK (
    triggered_by IS NULL OR triggered_by IN ('heartbeat', 'manual', 'webhook')
  )
);

CREATE INDEX IF NOT EXISTS idx_storyboard_status_agent
  ON agent_storyboard_status(agent_url);
