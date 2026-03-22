CREATE TABLE conversation_insights (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'posted', 'failed')),

  -- Raw stats captured before LLM analysis
  stats JSONB NOT NULL DEFAULT '{}',

  -- LLM-generated analysis
  analysis JSONB NOT NULL DEFAULT '{}',

  -- LLM metadata
  model_used TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,

  -- Slack posting
  slack_channel_id TEXT,
  slack_message_ts TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(week_start)
);

CREATE INDEX idx_conversation_insights_week ON conversation_insights(week_start DESC);
