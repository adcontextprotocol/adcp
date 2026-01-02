-- Organization activity log for tracking engagement and conversations
-- This replaces the simple prospect funnel with a richer activity-based model

CREATE TABLE IF NOT EXISTS org_activities (
  id SERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Activity details
  activity_type TEXT NOT NULL,  -- call, email, meeting, slack_dm, event, note, invoice_requested, etc.
  description TEXT,

  -- Who logged it and when it happened
  logged_by_user_id TEXT,  -- WorkOS user ID of person logging the activity
  logged_by_name TEXT,     -- Denormalized for display
  activity_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Next step tracking (optional - if this activity creates a follow-up)
  is_next_step BOOLEAN DEFAULT FALSE,
  next_step_due_date DATE,
  next_step_owner_user_id TEXT,
  next_step_owner_name TEXT,
  next_step_completed_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups by organization
CREATE INDEX IF NOT EXISTS idx_org_activities_org_id ON org_activities(organization_id);

-- Index for finding pending next steps
CREATE INDEX IF NOT EXISTS idx_org_activities_next_steps ON org_activities(is_next_step, next_step_due_date)
  WHERE is_next_step = TRUE AND next_step_completed_at IS NULL;

-- Index for recent activities
CREATE INDEX IF NOT EXISTS idx_org_activities_date ON org_activities(activity_date DESC);

-- Add engagement tracking fields to organizations table
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_requested_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS engagement_score INTEGER DEFAULT 0;

-- Comments for documentation
COMMENT ON TABLE org_activities IS 'Activity log for tracking all interactions with organizations';
COMMENT ON COLUMN org_activities.activity_type IS 'Type of activity: call, email, meeting, slack_dm, event, note, invoice_requested, referral, etc.';
COMMENT ON COLUMN org_activities.is_next_step IS 'If true, this activity represents a pending follow-up task';
COMMENT ON COLUMN organizations.invoice_requested_at IS 'When the org requested an invoice (highest engagement signal)';
COMMENT ON COLUMN organizations.engagement_score IS 'Computed engagement score based on activity signals';
