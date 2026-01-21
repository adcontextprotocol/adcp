-- Add composite index on industry_alerts for channel-based deduplication queries
-- This supports the NOT EXISTS subquery that checks if any perspective with
-- the same external_url has been alerted to a specific channel
CREATE INDEX IF NOT EXISTS idx_industry_alerts_channel_perspective
  ON industry_alerts(channel_id, perspective_id);
