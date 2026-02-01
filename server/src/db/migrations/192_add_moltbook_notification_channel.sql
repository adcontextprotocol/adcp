-- Add notification channel for Moltbook activity
-- This enables Slack notifications when Addie posts to Moltbook

INSERT INTO notification_channels (name, slack_channel_id, description, is_active)
VALUES (
  'addie_moltbook',
  'C0AD0TSF52L',
  'Notifications when Addie posts or comments on Moltbook',
  true
)
ON CONFLICT (slack_channel_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active;
