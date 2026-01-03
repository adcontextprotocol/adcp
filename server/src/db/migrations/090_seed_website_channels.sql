-- Seed initial website sections as notification channels
-- These channels are website-only (no Slack delivery) or dual-purpose

-- Research & Ideas channel (website-only)
INSERT INTO notification_channels (name, slack_channel_id, description, website_slug, website_enabled, display_order, fallback_rules)
VALUES (
  'Research & Ideas',
  'WEBSITE_ONLY_RESEARCH',
  'Thought leadership, white papers, member perspectives, and external research we highlight. Focus on original analysis and strategic insights about agentic AI in advertising.',
  'research',
  true,
  1,
  '{"min_quality": 4}'::jsonb
)
ON CONFLICT (slack_channel_id) DO UPDATE SET
  website_slug = EXCLUDED.website_slug,
  website_enabled = EXCLUDED.website_enabled,
  display_order = EXCLUDED.display_order;

-- Update existing Industry News channel to also be a website section
UPDATE notification_channels
SET website_slug = 'industry-news',
    website_enabled = true,
    display_order = 2
WHERE slack_channel_id NOT LIKE 'WEBSITE_ONLY_%'
  AND is_active = true
  AND name ILIKE '%industry%';

-- Learning Agentic channel (website-only)
INSERT INTO notification_channels (name, slack_channel_id, description, website_slug, website_enabled, display_order, fallback_rules)
VALUES (
  'Learning Agentic',
  'WEBSITE_ONLY_LEARNING',
  'Tutorials, guides, getting started content, and educational resources about agentic advertising and AdCP implementation.',
  'learning',
  true,
  3,
  '{"min_quality": 3}'::jsonb
)
ON CONFLICT (slack_channel_id) DO UPDATE SET
  website_slug = EXCLUDED.website_slug,
  website_enabled = EXCLUDED.website_enabled,
  display_order = EXCLUDED.display_order;

-- Announcements channel (website-only)
INSERT INTO notification_channels (name, slack_channel_id, description, website_slug, website_enabled, display_order, fallback_rules)
VALUES (
  'Announcements',
  'WEBSITE_ONLY_ANNOUNCE',
  'Member news, product launches, partnership announcements, and organization updates.',
  'announcements',
  true,
  4,
  '{"min_quality": 3}'::jsonb
)
ON CONFLICT (slack_channel_id) DO UPDATE SET
  website_slug = EXCLUDED.website_slug,
  website_enabled = EXCLUDED.website_enabled,
  display_order = EXCLUDED.display_order;
