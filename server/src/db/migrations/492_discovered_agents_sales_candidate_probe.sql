-- Migration: 492_discovered_agents_sales_candidate_probe.sql
-- Adds probe-backoff columns to support the sales_candidate state machine.
-- An agent discovered via publisher_properties in adagents.json is inserted
-- as 'sales_candidate'; each failed periodic probe increments
-- probe_failure_count and advances next_probe_after with exponential backoff
-- (1 day → 7 days → 30 days). Successful probe promotes the row to 'sales'
-- and resets both columns.

ALTER TABLE discovered_agents
  ADD COLUMN IF NOT EXISTS probe_failure_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_probe_after TIMESTAMPTZ;

-- Partial index: only rows in the candidate state need probe-scheduling lookups.
CREATE INDEX IF NOT EXISTS idx_discovered_agents_sales_candidate_probe
  ON discovered_agents (next_probe_after)
  WHERE agent_type = 'sales_candidate';
