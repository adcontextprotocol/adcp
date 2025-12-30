-- Migration: 047_addie_knowledge_slack.sql
-- Extend addie_knowledge to store Slack messages for fast local search

-- Add source_type to distinguish different content sources
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'manual';

-- Add Slack-specific metadata
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(255);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_channel_name VARCHAR(255);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_user_id VARCHAR(255);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_username VARCHAR(255);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_ts VARCHAR(255);
ALTER TABLE addie_knowledge ADD COLUMN IF NOT EXISTS slack_permalink TEXT;

-- Index for deduplication (prevent storing same message twice)
CREATE UNIQUE INDEX IF NOT EXISTS idx_addie_knowledge_slack_ts
  ON addie_knowledge(slack_channel_id, slack_ts)
  WHERE source_type = 'slack';

-- Index for source_type filtering
CREATE INDEX IF NOT EXISTS idx_addie_knowledge_source_type ON addie_knowledge(source_type);

-- Update category comment
COMMENT ON COLUMN addie_knowledge.source_type IS 'Source: manual, slack, perspective, external_link';
COMMENT ON COLUMN addie_knowledge.slack_channel_id IS 'Slack channel ID for slack source_type';
COMMENT ON COLUMN addie_knowledge.slack_ts IS 'Slack message timestamp for deduplication';
COMMENT ON COLUMN addie_knowledge.slack_permalink IS 'Slack permalink URL for citations';
