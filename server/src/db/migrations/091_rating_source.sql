-- Add rating_source to distinguish user feedback from admin feedback
-- User feedback comes from Slack buttons or web chat
-- Admin feedback comes from the admin dashboard

ALTER TABLE addie_thread_messages
ADD COLUMN IF NOT EXISTS rating_source VARCHAR(20)
  CHECK (rating_source IN ('user', 'admin'));

-- Backfill existing ratings as 'admin' since user feedback wasn't working
UPDATE addie_thread_messages
SET rating_source = 'admin'
WHERE rating IS NOT NULL AND rating_source IS NULL;

COMMENT ON COLUMN addie_thread_messages.rating_source IS 'Source of the rating: user (from Slack/web) or admin (from dashboard)';
