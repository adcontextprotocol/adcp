-- Migration 501: durable backoff state for agents whose type remains unknown.
--
-- The crawler probes registered/discovered agents for capability metadata, but
-- agents that cannot be classified should not be re-probed every crawl tick
-- forever. These columns let the crawler retry unknown classifications on an
-- exponential cadence, then stop after a bounded number of attempts with a
-- terminal reason that distinguishes unreachable endpoints from reachable but
-- unclassifiable agents.

ALTER TABLE agent_capabilities_snapshot
  ADD COLUMN IF NOT EXISTS unknown_probe_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_probe_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_probe_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS probe_terminal_state TEXT;

ALTER TABLE agent_capabilities_snapshot
  DROP CONSTRAINT IF EXISTS agent_capabilities_snapshot_probe_terminal_state_check;

ALTER TABLE agent_capabilities_snapshot
  ADD CONSTRAINT agent_capabilities_snapshot_probe_terminal_state_check
  CHECK (probe_terminal_state IS NULL OR probe_terminal_state IN ('unreachable', 'unclassifiable'));

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_unknown_probe_due
  ON agent_capabilities_snapshot (next_probe_after)
  WHERE inferred_type IS NULL AND probe_terminal_state IS NULL;
