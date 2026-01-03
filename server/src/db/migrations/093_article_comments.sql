-- Migration: Article-thread linking for comments
-- Links articles to the unified thread system for bidirectional Slack-web comments

-- Add article reference to addie_threads for comment threads
ALTER TABLE addie_threads
  ADD COLUMN IF NOT EXISTS article_knowledge_id INTEGER REFERENCES addie_knowledge(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_addie_threads_article ON addie_threads(article_knowledge_id)
  WHERE article_knowledge_id IS NOT NULL;

-- Extend industry_alerts to link to thread system
ALTER TABLE industry_alerts
  ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES addie_threads(thread_id);

CREATE INDEX IF NOT EXISTS idx_industry_alerts_thread ON industry_alerts(thread_id)
  WHERE thread_id IS NOT NULL;

-- View for article comments (merges web and Slack sources)
CREATE OR REPLACE VIEW article_comments AS
SELECT
  k.id as knowledge_id,
  k.title as article_title,
  k.source_url,
  t.thread_id,
  t.channel as comment_source,
  t.message_count,
  t.last_message_at,
  ia.channel_id as slack_channel_id,
  ia.message_ts as slack_thread_ts,
  ia.sent_at as slack_alert_sent_at
FROM addie_knowledge k
LEFT JOIN industry_alerts ia ON ia.knowledge_id = k.id
LEFT JOIN addie_threads t ON (
  t.article_knowledge_id = k.id
  OR t.thread_id = ia.thread_id
)
WHERE k.fetch_status = 'success';

COMMENT ON COLUMN addie_threads.article_knowledge_id IS 'Reference to addie_knowledge for article comment threads';
COMMENT ON VIEW article_comments IS 'Unified view of comments for articles from both web and Slack sources';
