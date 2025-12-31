-- Industry RSS feed monitoring for Addie
-- RSS articles become perspectives with source_type = 'rss'
-- Uses existing perspectives + content curator infrastructure

-- Feed sources (publications we monitor)
CREATE TABLE IF NOT EXISTS industry_feeds (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL UNIQUE,
  category TEXT, -- e.g., 'ad-tech', 'marketing', 'media'
  fetch_interval_minutes INTEGER DEFAULT 30,
  last_fetched_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add RSS source tracking to perspectives
-- source_type: 'manual' (default), 'rss'
-- feed_id: links to industry_feeds for RSS-sourced perspectives
-- guid: unique identifier from RSS feed for deduplication
ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS feed_id INTEGER REFERENCES industry_feeds(id),
  ADD COLUMN IF NOT EXISTS guid TEXT;

-- Index for finding RSS perspectives by feed
CREATE INDEX IF NOT EXISTS idx_perspectives_feed ON perspectives(feed_id) WHERE feed_id IS NOT NULL;

-- Index for deduplication (feed_id + guid must be unique for RSS)
CREATE UNIQUE INDEX IF NOT EXISTS idx_perspectives_feed_guid ON perspectives(feed_id, guid) WHERE guid IS NOT NULL;

-- Add industry-specific fields to addie_knowledge for alerting
ALTER TABLE addie_knowledge
  ADD COLUMN IF NOT EXISTS mentions_agentic BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS mentions_adcp BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS competitor_mentions TEXT[],
  ADD COLUMN IF NOT EXISTS article_type TEXT; -- news, opinion, analysis, announcement

-- Index for finding high-priority content
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_mentions ON addie_knowledge(mentions_agentic, mentions_adcp)
  WHERE mentions_agentic = true OR mentions_adcp = true;

-- Alert tracking (which perspectives have been sent to Slack)
CREATE TABLE IF NOT EXISTS industry_alerts (
  id SERIAL PRIMARY KEY,
  perspective_id UUID REFERENCES perspectives(id) ON DELETE CASCADE,
  knowledge_id INTEGER REFERENCES addie_knowledge(id) ON DELETE SET NULL,
  alert_level TEXT NOT NULL, -- urgent, high, medium, digest
  channel_id TEXT,
  message_ts TEXT, -- Slack message timestamp
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industry_alerts_perspective ON industry_alerts(perspective_id);

-- Seed initial feeds
INSERT INTO industry_feeds (name, feed_url, category) VALUES
  ('AdExchanger', 'https://www.adexchanger.com/feed', 'ad-tech'),
  ('Digiday', 'https://digiday.com/feed', 'ad-tech'),
  ('AdWeek', 'https://www.adweek.com/feed', 'advertising'),
  ('Marketing Dive', 'https://www.marketingdive.com/feeds/news/', 'marketing'),
  ('TechCrunch Advertising', 'https://techcrunch.com/tag/advertising/feed/', 'tech')
ON CONFLICT (feed_url) DO NOTHING;
