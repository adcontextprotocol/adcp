-- Migration: 034_slack_activity_tracking.sql
-- Track Slack activity events for engagement signals

-- Slack activity events table
CREATE TABLE IF NOT EXISTS slack_activities (
  id SERIAL PRIMARY KEY,

  -- Who and when
  slack_user_id VARCHAR(255) NOT NULL,
  activity_type VARCHAR(50) NOT NULL,  -- message, reaction, thread_reply, channel_join, etc.

  -- Where (channel context)
  channel_id VARCHAR(255),
  channel_name VARCHAR(255),

  -- When
  activity_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Optional: link to org (if user is mapped to an AAO user in an org)
  organization_id TEXT REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  -- Metadata (e.g., message length, thread_ts for replies)
  metadata JSONB,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_slack_activities_user ON slack_activities(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_slack_activities_type ON slack_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_slack_activities_timestamp ON slack_activities(activity_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_slack_activities_org ON slack_activities(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slack_activities_channel ON slack_activities(channel_id);

-- Aggregated daily activity counts per user (for performance)
CREATE TABLE IF NOT EXISTS slack_activity_daily (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(255) NOT NULL,
  activity_date DATE NOT NULL,
  message_count INTEGER DEFAULT 0,
  reaction_count INTEGER DEFAULT 0,
  thread_reply_count INTEGER DEFAULT 0,
  channel_join_count INTEGER DEFAULT 0,
  total_activity INTEGER DEFAULT 0,

  -- Link to org if mapped
  organization_id TEXT REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,

  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(slack_user_id, activity_date)
);

CREATE INDEX IF NOT EXISTS idx_slack_activity_daily_user_date ON slack_activity_daily(slack_user_id, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_slack_activity_daily_org ON slack_activity_daily(organization_id) WHERE organization_id IS NOT NULL;

-- Add last_slack_activity_at to slack_user_mappings for quick engagement checks
ALTER TABLE slack_user_mappings ADD COLUMN IF NOT EXISTS last_slack_activity_at TIMESTAMP WITH TIME ZONE;

-- Comments
COMMENT ON TABLE slack_activities IS 'Raw Slack activity events for engagement tracking';
COMMENT ON TABLE slack_activity_daily IS 'Daily aggregated Slack activity per user for performance';
COMMENT ON COLUMN slack_activities.activity_type IS 'Type: message, reaction, thread_reply, channel_join, file_share, etc.';
COMMENT ON COLUMN slack_activity_daily.total_activity IS 'Sum of all activity types for the day';
