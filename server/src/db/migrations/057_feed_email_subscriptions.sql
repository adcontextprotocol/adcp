-- Add email subscription support to industry feeds
-- Each feed can optionally receive newsletters via email
-- Emails are received at feed-<name>@updates.agenticadvertising.org

-- Add email-related columns to industry_feeds
ALTER TABLE industry_feeds
  ADD COLUMN IF NOT EXISTS email_slug TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS accepts_email BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_email_at TIMESTAMPTZ;

-- Index for looking up feeds by email slug (used in webhook handler)
CREATE INDEX IF NOT EXISTS idx_industry_feeds_email_slug ON industry_feeds(email_slug)
  WHERE email_slug IS NOT NULL;

-- Update source_type enum comment to include email
COMMENT ON COLUMN perspectives.source_type IS 'Source type: manual, rss, or email';
