-- Add Community channel for event recaps, photos, and member highlights

INSERT INTO notification_channels (name, slack_channel_id, description, website_slug, website_enabled, display_order, fallback_rules)
VALUES (
  'Community',
  'WEBSITE_ONLY_COMMUNITY',
  'Event recaps, photos, and updates from the AgenticAdvertising.org community.',
  'community',
  true,
  5,
  '{"min_quality": 3}'::jsonb
)
ON CONFLICT (slack_channel_id) DO UPDATE SET
  website_slug = EXCLUDED.website_slug,
  website_enabled = EXCLUDED.website_enabled,
  display_order = EXCLUDED.display_order;
