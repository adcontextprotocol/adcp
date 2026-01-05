-- Migration: 108_event_groups.sql
-- Add 'event' committee type and link working groups to events
-- This enables temporary "chapter-like" groups for industry events (CES, Cannes Lions, etc.)

-- =====================================================
-- ADD 'EVENT' COMMITTEE TYPE
-- =====================================================

-- Drop and recreate constraint to add 'event' type
ALTER TABLE working_groups
DROP CONSTRAINT IF EXISTS working_groups_committee_type_check;

ALTER TABLE working_groups
ADD CONSTRAINT working_groups_committee_type_check
CHECK (committee_type IN ('working_group', 'council', 'chapter', 'governance', 'event'));

-- =====================================================
-- ADD EVENT LINKAGE COLUMNS
-- =====================================================

ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS linked_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS event_start_date DATE,
ADD COLUMN IF NOT EXISTS event_end_date DATE,
ADD COLUMN IF NOT EXISTS auto_archive_after_event BOOLEAN DEFAULT TRUE;

-- Index for finding event groups
CREATE INDEX IF NOT EXISTS idx_working_groups_linked_event ON working_groups(linked_event_id)
  WHERE linked_event_id IS NOT NULL;

-- Index for filtering by event committee type
CREATE INDEX IF NOT EXISTS idx_working_groups_event_type ON working_groups(committee_type)
  WHERE committee_type = 'event';

-- Index for finding upcoming vs past event groups
CREATE INDEX IF NOT EXISTS idx_working_groups_event_dates ON working_groups(event_start_date, event_end_date)
  WHERE committee_type = 'event';

COMMENT ON COLUMN working_groups.linked_event_id IS 'Links this group to an industry event (for event-type committees)';
COMMENT ON COLUMN working_groups.event_start_date IS 'Cached from event for display/filtering without join';
COMMENT ON COLUMN working_groups.event_end_date IS 'Cached from event for display/filtering without join';
COMMENT ON COLUMN working_groups.auto_archive_after_event IS 'If TRUE, auto-archive group after event ends';

-- =====================================================
-- ADD INTEREST LEVEL TO MEMBERSHIPS
-- =====================================================

-- Track why someone joined an event group
ALTER TABLE working_group_memberships
ADD COLUMN IF NOT EXISTS interest_level VARCHAR(50),
ADD COLUMN IF NOT EXISTS interest_source VARCHAR(50);

-- Add constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wg_membership_interest_level_check'
  ) THEN
    ALTER TABLE working_group_memberships
    ADD CONSTRAINT wg_membership_interest_level_check
    CHECK (interest_level IS NULL OR interest_level IN ('maybe', 'interested', 'attending', 'attended'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wg_membership_interest_source_check'
  ) THEN
    ALTER TABLE working_group_memberships
    ADD CONSTRAINT wg_membership_interest_source_check
    CHECK (interest_source IS NULL OR interest_source IN ('outreach', 'registration', 'manual', 'slack_join'));
  END IF;
END $$;

COMMENT ON COLUMN working_group_memberships.interest_level IS 'For event groups: maybe, interested, attending, attended';
COMMENT ON COLUMN working_group_memberships.interest_source IS 'How they expressed interest: outreach, registration, manual, slack_join';

-- =====================================================
-- VIEW: UPCOMING EVENT GROUPS
-- =====================================================

CREATE OR REPLACE VIEW upcoming_event_groups AS
SELECT
  wg.id,
  wg.name,
  wg.slug,
  wg.description,
  wg.slack_channel_url,
  wg.slack_channel_id,
  wg.status,
  wg.linked_event_id,
  wg.event_start_date,
  wg.event_end_date,
  e.title as event_title,
  e.venue_name,
  e.venue_city as event_city,
  e.venue_country as event_country,
  e.start_time as event_start_time,
  e.end_time as event_end_time,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active') as member_count,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active' AND m.interest_level = 'attending') as attending_count
FROM working_groups wg
LEFT JOIN events e ON wg.linked_event_id = e.id
WHERE wg.committee_type = 'event'
  AND wg.status = 'active'
  AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)
ORDER BY wg.event_start_date ASC NULLS LAST;

COMMENT ON VIEW upcoming_event_groups IS 'Active event groups for upcoming or ongoing events';
