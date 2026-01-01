-- Org Admin Group DM Table
-- Tracks Slack group DM channels for organization admins/owners

CREATE TABLE IF NOT EXISTS org_admin_group_dms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which organization this group DM is for
  workos_organization_id VARCHAR(255) NOT NULL UNIQUE REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- The Slack channel ID for the group DM (Slack IDs are typically 11 chars but using 50 for future-proofing)
  slack_channel_id VARCHAR(50) NOT NULL,

  -- The Slack user IDs of admins in this group DM
  -- Used to detect when admins change and we need to create a new group DM
  admin_slack_user_ids TEXT[] NOT NULL,

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Note: workos_organization_id already has a UNIQUE constraint which creates an implicit index

-- Trigger for updated_at
CREATE TRIGGER update_org_admin_group_dms_updated_at
  BEFORE UPDATE ON org_admin_group_dms
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
