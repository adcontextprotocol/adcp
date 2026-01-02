-- Extend notification_channels to support website distribution
-- Channels can now be displayed as website sections in addition to (or instead of) Slack

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS website_slug VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS website_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

-- Index for website-enabled channels lookup
CREATE INDEX IF NOT EXISTS idx_notification_channels_website
  ON notification_channels(website_enabled, display_order) WHERE website_enabled = true;

COMMENT ON COLUMN notification_channels.website_slug IS 'URL slug for website section (e.g., industry-news)';
COMMENT ON COLUMN notification_channels.website_enabled IS 'Whether to show this channel as a website section';
COMMENT ON COLUMN notification_channels.display_order IS 'Sort order for website display (lower = first)';
