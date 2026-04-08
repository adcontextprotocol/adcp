-- Agent monitoring controls: outbound request logging and owner-configurable check frequency.

-- Log of automated outbound requests AAO makes to agent endpoints.
CREATE TABLE IF NOT EXISTS agent_outbound_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url TEXT NOT NULL,
  request_type TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  response_time_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_request_type CHECK (
    request_type IN ('health_check', 'discovery', 'compliance', 'crawl', 'validation')
  )
);

CREATE INDEX IF NOT EXISTS idx_outbound_requests_agent_time
  ON agent_outbound_requests(agent_url, created_at DESC);

-- For retention cleanup
CREATE INDEX IF NOT EXISTS idx_outbound_requests_created
  ON agent_outbound_requests(created_at);

-- Owner-configurable monitoring controls on existing metadata table.
ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS monitoring_paused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS check_interval_hours INTEGER NOT NULL DEFAULT 12;

-- Runs after the column is added above; safe since migration runs exactly once.
DO $$ BEGIN
  ALTER TABLE agent_registry_metadata
    ADD CONSTRAINT valid_check_interval CHECK (check_interval_hours BETWEEN 6 AND 168);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE agent_registry_metadata
  ADD COLUMN IF NOT EXISTS monitoring_paused_at TIMESTAMPTZ;
