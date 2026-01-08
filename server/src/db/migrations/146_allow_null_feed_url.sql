-- Allow feed_url to be NULL for email-only feeds
-- Previously email-only feeds used 'email://slug' placeholder URLs,
-- but this is cleaner and matches how the code/UI expects to work

-- Drop the NOT NULL constraint on feed_url
ALTER TABLE industry_feeds ALTER COLUMN feed_url DROP NOT NULL;

-- Drop the UNIQUE constraint since NULL values should be allowed
-- (multiple email-only feeds would all have NULL feed_url)
ALTER TABLE industry_feeds DROP CONSTRAINT IF EXISTS industry_feeds_feed_url_key;

-- Add a partial unique constraint that only applies to non-null URLs
CREATE UNIQUE INDEX IF NOT EXISTS industry_feeds_feed_url_unique
ON industry_feeds (feed_url) WHERE feed_url IS NOT NULL;

-- Migrate existing email:// placeholder URLs to NULL
UPDATE industry_feeds
SET feed_url = NULL
WHERE feed_url LIKE 'email://%';
