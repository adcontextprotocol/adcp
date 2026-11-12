-- next_compliance_check_at carried the heartbeat cadence, the in-flight batch
-- lock and skip deferrals at once, so "running now", "skipped repeatedly" and
-- "checked an hour ago" were indistinguishable (#7693). The lock moves to its
-- own column, and every heartbeat attempt records its outcome, so cadence,
-- lock and repeated deferral can be told apart.
--
--   compliance_lock_until       the heartbeat is holding this agent until then
--                               (in-flight batch claim, crash quarantine, or a
--                               short hold while another full suite runs).
--                               Expires on its own, so a dead worker cannot
--                               strand the agent.
--   last_heartbeat_attempt_at   when the last heartbeat attempt ended.
--   last_heartbeat_skip_reason  why that attempt published no verdict; NULL
--                               after a published one.
--   last_heartbeat_success_at   when a heartbeat last published an
--                               authoritative verdict. A skip never refreshes
--                               it, so it can key an independent-check floor.

-- DDL lock guard: heartbeat and owner-test transactions hold locks on this
-- table, and ADD COLUMN needs ACCESS EXCLUSIVE. Queued behind them it would
-- block every reader of agent registry metadata. Fail and retry the deploy
-- instead of waiting indefinitely (same guard as 475 and 557).
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS compliance_lock_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_skip_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_heartbeat_success_at TIMESTAMPTZ;

-- A batch claimed by the previous release holds its lock in the cadence column.
-- Move it so the claim still protects in-flight agents (orphan reconciliation
-- and expiry now read the new column), and leave the cadence due: a claim is
-- only taken on an agent that was already due.
UPDATE agent_registry_metadata
SET compliance_lock_until = next_compliance_check_at,
    next_compliance_check_at = NULL
WHERE heartbeat_claim_owner IS NOT NULL
  AND compliance_lock_until IS NULL;

-- Seed the attempt and success history from recorded heartbeat runs, so the
-- first deploy does not read every agent as never checked. Skips that recorded
-- no run left nothing to recover, so their reason stays unknown (NULL).
UPDATE agent_registry_metadata m
SET last_heartbeat_attempt_at = runs.last_attempt_at,
    last_heartbeat_success_at = runs.last_success_at
FROM (
  SELECT agent_url,
         MAX(tested_at) AS last_attempt_at,
         MAX(tested_at) FILTER (WHERE is_authoritative) AS last_success_at
  FROM agent_compliance_runs
  WHERE triggered_by = 'heartbeat' AND dry_run = FALSE
  GROUP BY agent_url
) runs
WHERE runs.agent_url = m.agent_url
  AND m.last_heartbeat_attempt_at IS NULL
  AND m.last_heartbeat_success_at IS NULL;
