-- Migration: 254_weekly_digest.sql
-- Weekly digest table and email category for Addie's weekly briefing

-- Track digest editions
CREATE TABLE IF NOT EXISTS weekly_digests (
  id SERIAL PRIMARY KEY,
  edition_date DATE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'skipped')),
  approved_by TEXT,                       -- WorkOS user ID of approver
  approved_at TIMESTAMP WITH TIME ZONE,
  review_channel_id TEXT,                 -- Slack channel where review was posted
  review_message_ts TEXT,                 -- Slack message ts for the review post
  content JSONB NOT NULL,                 -- Tagged content sections
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  sent_at TIMESTAMP WITH TIME ZONE,
  send_stats JSONB                        -- { email_count, slack_count, by_segment }
);

CREATE INDEX IF NOT EXISTS idx_weekly_digests_status ON weekly_digests (status);
CREATE INDEX IF NOT EXISTS idx_weekly_digests_edition_date ON weekly_digests (edition_date DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_digests_review_message ON weekly_digests (review_channel_id, review_message_ts) WHERE review_channel_id IS NOT NULL;

-- Add weekly_digest email category
INSERT INTO email_categories (id, name, description, default_enabled, sort_order)
VALUES (
  'weekly_digest',
  'Weekly Digest',
  'Tuesday briefing with community updates and industry news',
  true,
  1
)
ON CONFLICT (id) DO NOTHING;

-- Track digest feedback (thumbs up/down from email)
CREATE TABLE IF NOT EXISTS digest_feedback (
  id SERIAL PRIMARY KEY,
  edition_date DATE NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
  tracking_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digest_feedback_edition ON digest_feedback (edition_date);
