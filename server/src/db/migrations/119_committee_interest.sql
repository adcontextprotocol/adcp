-- Committee interest tracking
-- Tracks users who express interest in joining committees (especially launching councils)

CREATE TABLE IF NOT EXISTS committee_interest (
  id SERIAL PRIMARY KEY,
  working_group_id TEXT NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  workos_user_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  workos_organization_id TEXT,
  user_org_name TEXT,
  interest_level TEXT DEFAULT 'participant' CHECK (interest_level IN ('participant', 'leader')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(working_group_id, workos_user_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_committee_interest_working_group ON committee_interest(working_group_id);
CREATE INDEX IF NOT EXISTS idx_committee_interest_user ON committee_interest(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_committee_interest_created ON committee_interest(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_committee_interest_org ON committee_interest(workos_organization_id)
  WHERE workos_organization_id IS NOT NULL;

COMMENT ON TABLE committee_interest IS 'Tracks users interested in joining committees before they launch';
COMMENT ON COLUMN committee_interest.interest_level IS 'Whether user wants to be a participant or leader';
