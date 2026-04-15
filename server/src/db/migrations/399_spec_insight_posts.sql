-- Track weekly spec insight posts to avoid duplicates and inform future generation.

CREATE TABLE IF NOT EXISTS spec_insight_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel_id VARCHAR(50) NOT NULL,
  slack_message_ts VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_insight_posts_created ON spec_insight_posts(created_at DESC);
