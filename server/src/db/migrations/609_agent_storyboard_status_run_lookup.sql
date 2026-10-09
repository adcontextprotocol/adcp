-- The public compliance card and member storyboard detail both resolve rows
-- for one agent's latest authoritative run. Avoid repeated table scans for
-- agents with large or long-lived compliance histories.
CREATE INDEX IF NOT EXISTS agent_storyboard_status_agent_run_idx
  ON agent_storyboard_status (agent_url, run_id);
