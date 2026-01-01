-- Notification channels for AI-driven industry alerts routing
-- Allows admins to configure multiple Slack channels with descriptions for Addie

CREATE TABLE IF NOT EXISTS notification_channels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slack_channel_id VARCHAR(50) NOT NULL UNIQUE,
  description TEXT NOT NULL,  -- Description for Addie to understand channel purpose
  fallback_rules JSONB DEFAULT '{}',  -- e.g., {"min_quality": 4, "require_tags": ["agentic"]}
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for active channels lookup
CREATE INDEX IF NOT EXISTS idx_notification_channels_active
  ON notification_channels(is_active) WHERE is_active = true;

-- Add routing decisions to addie_knowledge
-- This stores which channels Addie decided to route each article to
ALTER TABLE addie_knowledge
  ADD COLUMN IF NOT EXISTS notification_channel_ids TEXT[];

-- Index for routing lookup
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_routing
  ON addie_knowledge USING GIN(notification_channel_ids);

-- Comments for documentation
COMMENT ON TABLE notification_channels IS 'Slack channels configured for AI-driven industry alert routing';
COMMENT ON COLUMN notification_channels.description IS 'Description for Addie to understand what content belongs in this channel';
COMMENT ON COLUMN notification_channels.fallback_rules IS 'JSON rules applied when AI routing is uncertain: {min_quality, require_tags, require_mentions_adcp, require_mentions_agentic}';
COMMENT ON COLUMN addie_knowledge.notification_channel_ids IS 'Slack channel IDs that Addie decided should receive alerts for this content';
