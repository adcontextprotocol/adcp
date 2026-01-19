-- Add index on external_url for cross-feed deduplication
-- When the same article appears in multiple RSS feeds (e.g., Adweek main + Adweek AI),
-- we need to detect duplicates by URL, not just by (feed_id, guid)
CREATE INDEX IF NOT EXISTS idx_perspectives_external_url
  ON perspectives(external_url)
  WHERE external_url IS NOT NULL;
