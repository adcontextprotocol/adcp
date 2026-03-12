-- Add badge image URL column to user_credentials
-- The Certifier designs API returns CDN-hosted badge image URLs.
-- We store them at issue time so the frontend can render badges without extra API calls.

ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS certifier_badge_url TEXT;
