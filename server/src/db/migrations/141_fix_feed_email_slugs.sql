-- Migration: 141_fix_feed_email_slugs.sql
-- Fix email_slug values that are missing the 'feed-' prefix
--
-- The email webhook extracts the full local part from addresses like:
--   feed-campaign-uk@updates.agenticadvertising.org -> slug = 'feed-campaign-uk'
--
-- But migration 060 inserted slugs without the prefix (e.g., 'campaign-uk')
-- This caused lookups to fail with "No matching feed found for inbound email"

UPDATE industry_feeds
SET email_slug = 'feed-' || email_slug
WHERE email_slug IS NOT NULL
  AND accepts_email = true
  AND email_slug NOT LIKE 'feed-%';
