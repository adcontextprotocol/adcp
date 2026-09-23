-- Owner "Requeue comply" marks an agent eligible for the scheduled heartbeat,
-- but the batch is ordered by last_checked_at ASC NULLS FIRST, so an agent with
-- a recent authoritative run sorts behind every agent checked earlier and a
-- requeue never moves it forward (#7632). Record the requeue time so the
-- heartbeat can serve explicit requeues first; cleared when an authoritative
-- run is published.
ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;
