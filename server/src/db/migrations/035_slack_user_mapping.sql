-- Migration: 031_slack_user_mapping.sql
-- Slack user mapping for AAO member integration
-- Maps Slack workspace users to AAO website members (WorkOS users)

-- Slack User Mapping Table
CREATE TABLE IF NOT EXISTS slack_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Slack user info
  slack_user_id VARCHAR(255) NOT NULL UNIQUE,
  slack_email VARCHAR(255),
  slack_display_name VARCHAR(255),
  slack_real_name VARCHAR(255),
  slack_is_bot BOOLEAN DEFAULT false,
  slack_is_deleted BOOLEAN DEFAULT false,

  -- AAO/WorkOS user mapping (NULL if not linked)
  workos_user_id VARCHAR(255),

  -- Status: mapped, unmapped, pending_verification
  mapping_status VARCHAR(50) NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_status IN ('mapped', 'unmapped', 'pending_verification')),

  -- How mapped: email_auto, manual_admin, user_claimed
  mapping_source VARCHAR(50)
    CHECK (mapping_source IN ('email_auto', 'manual_admin', 'user_claimed')),

  -- Nudge tracking (for Phase 2)
  nudge_opt_out BOOLEAN DEFAULT false,
  nudge_opt_out_at TIMESTAMP WITH TIME ZONE,
  last_nudge_at TIMESTAMP WITH TIME ZONE,
  nudge_count INTEGER DEFAULT 0,

  -- Timestamps
  last_slack_sync_at TIMESTAMP WITH TIME ZONE,
  mapped_at TIMESTAMP WITH TIME ZONE,
  mapped_by_user_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_slack_mapping_workos_user ON slack_user_mappings(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_slack_mapping_email ON slack_user_mappings(slack_email);
CREATE INDEX IF NOT EXISTS idx_slack_mapping_status ON slack_user_mappings(mapping_status);
CREATE INDEX IF NOT EXISTS idx_slack_mapping_unmapped_active
  ON slack_user_mappings(mapping_status)
  WHERE mapping_status = 'unmapped' AND slack_is_bot = false AND slack_is_deleted = false;

-- Trigger for updated_at
CREATE TRIGGER update_slack_user_mappings_updated_at
  BEFORE UPDATE ON slack_user_mappings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE slack_user_mappings IS 'Maps Slack workspace users to AAO website members';
COMMENT ON COLUMN slack_user_mappings.workos_user_id IS 'WorkOS user ID if linked, NULL if unmapped';
COMMENT ON COLUMN slack_user_mappings.mapping_status IS 'mapped = linked to AAO account, unmapped = no link, pending_verification = awaiting confirmation';
COMMENT ON COLUMN slack_user_mappings.mapping_source IS 'How the mapping was established';
COMMENT ON COLUMN slack_user_mappings.nudge_opt_out IS 'User opted out of receiving Slack DM nudges';

-- Add slack_channel_id to working_groups for API use (more useful than URL)
ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_working_groups_slack_channel ON working_groups(slack_channel_id);

COMMENT ON COLUMN working_groups.slack_channel_id IS 'Slack channel ID for API operations';
