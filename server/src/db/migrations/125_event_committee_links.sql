-- Migration: 125_event_committee_links.sql
-- Add a table to link events to committees (working groups, chapters, councils, etc.)
-- This replaces the venue_city-based linking for chapters with explicit committee relationships

-- =====================================================
-- EVENT COMMITTEE LINKS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS event_committee_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  committee_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'host',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id VARCHAR(255),

  UNIQUE(event_id, committee_id)
);

-- Add constraint for valid roles
ALTER TABLE event_committee_links
ADD CONSTRAINT event_committee_links_role_check
CHECK (role IN ('host', 'sponsor', 'partner', 'participant'));

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_event_committee_links_event ON event_committee_links(event_id);
CREATE INDEX IF NOT EXISTS idx_event_committee_links_committee ON event_committee_links(committee_id);

COMMENT ON TABLE event_committee_links IS 'Links events to committees with their relationship role';
COMMENT ON COLUMN event_committee_links.role IS 'Relationship type: host (organizes), sponsor, partner, participant';
COMMENT ON COLUMN event_committee_links.created_by_user_id IS 'User who created this link (for audit)';
