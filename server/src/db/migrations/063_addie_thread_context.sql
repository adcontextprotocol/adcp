-- Addie Thread Context Store
-- Stores thread context for Slack Assistant threads
-- Required by the Bolt Assistant's ThreadContextStore interface
--
-- Context is needed because message.im events don't include
-- which channel the user was viewing when they opened the assistant.
-- We capture this from assistant_thread_started and assistant_thread_context_changed
-- events and persist it for later message handling.

CREATE TABLE IF NOT EXISTS addie_thread_context (
  -- The DM channel where the assistant thread lives
  channel_id VARCHAR(255) NOT NULL,
  -- The thread timestamp (unique identifier for the thread)
  thread_ts VARCHAR(255) NOT NULL,
  -- The channel the user was viewing when they opened/switched context
  context_channel_id VARCHAR(255) NOT NULL,
  -- The team ID for the context
  context_team_id VARCHAR(255) NOT NULL,
  -- Enterprise ID (for enterprise grid installations)
  context_enterprise_id VARCHAR(255),
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Primary key on channel + thread (each thread has one context)
  PRIMARY KEY (channel_id, thread_ts)
);

-- Index for cleanup queries (find old contexts)
CREATE INDEX IF NOT EXISTS idx_addie_thread_context_created_at
ON addie_thread_context(created_at);

-- Comment for documentation
COMMENT ON TABLE addie_thread_context IS 'Persists Slack Assistant thread context for Bolt ThreadContextStore';
