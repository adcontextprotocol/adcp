-- Track all Anthropic API calls for performance metrics
-- Captures both chat messages (Sonnet) and background tasks (Haiku)

CREATE TABLE addie_api_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,  -- 'chat', 'router', 'insight_extraction', 'outbound_planning', etc.
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,
  thread_id UUID REFERENCES addie_threads(thread_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for performance queries
CREATE INDEX idx_addie_api_calls_created_at ON addie_api_calls(created_at);
CREATE INDEX idx_addie_api_calls_model ON addie_api_calls(model);
CREATE INDEX idx_addie_api_calls_purpose ON addie_api_calls(purpose);
