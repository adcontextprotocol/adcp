-- Migration: 121_industry_gatherings.sql
-- Rename 'event' committee type to 'industry_gathering' and add logo/website fields
-- Industry gatherings are external events like CES, Cannes Lions, etc. (not AAO-hosted events)

-- =====================================================
-- RENAME 'EVENT' TO 'INDUSTRY_GATHERING'
-- =====================================================

-- First, update any existing 'event' types to 'industry_gathering'
UPDATE working_groups
SET committee_type = 'industry_gathering'
WHERE committee_type = 'event';

-- Drop and recreate constraint with new type name
ALTER TABLE working_groups
DROP CONSTRAINT IF EXISTS working_groups_committee_type_check;

ALTER TABLE working_groups
ADD CONSTRAINT working_groups_committee_type_check
CHECK (committee_type IN ('working_group', 'council', 'chapter', 'governance', 'industry_gathering'));

-- =====================================================
-- ADD LOGO AND WEBSITE FIELDS
-- =====================================================

ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS logo_url TEXT,
ADD COLUMN IF NOT EXISTS website_url TEXT;

COMMENT ON COLUMN working_groups.logo_url IS 'Logo URL for the committee (especially for industry gatherings)';
COMMENT ON COLUMN working_groups.website_url IS 'External website URL (e.g., CES official site)';

-- =====================================================
-- UPDATE INDEXES FOR INDUSTRY GATHERINGS
-- =====================================================

-- Drop old event-specific indexes
DROP INDEX IF EXISTS idx_working_groups_event_type;

-- Create index for industry gathering type
CREATE INDEX IF NOT EXISTS idx_working_groups_industry_gathering_type ON working_groups(committee_type)
  WHERE committee_type = 'industry_gathering';

-- =====================================================
-- UPDATE VIEW: UPCOMING INDUSTRY GATHERINGS
-- =====================================================

-- Drop old view if exists
DROP VIEW IF EXISTS upcoming_event_groups;

-- Create new view with updated terminology and ordering
CREATE OR REPLACE VIEW upcoming_industry_gatherings AS
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
  wg.event_location,
  wg.logo_url,
  wg.website_url,
  wg.auto_archive_after_event,
  e.title as linked_event_title,
  e.venue_name,
  e.venue_city,
  e.venue_country,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active') as member_count,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active' AND m.interest_level = 'attending') as attending_count,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active' AND m.interest_level = 'not_attending') as not_attending_count
FROM working_groups wg
LEFT JOIN events e ON wg.linked_event_id = e.id
WHERE wg.committee_type = 'industry_gathering'
  AND wg.status = 'active'
  AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)
ORDER BY wg.event_start_date ASC NULLS LAST;

COMMENT ON VIEW upcoming_industry_gatherings IS 'Active industry gathering groups for upcoming external events (CES, Cannes Lions, etc.)';

-- =====================================================
-- UPDATE ARCHIVE FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION archive_past_industry_gatherings()
RETURNS TABLE(archived_count INTEGER, archived_groups TEXT[]) AS $$
DECLARE
  v_archived_count INTEGER;
  v_archived_groups TEXT[];
BEGIN
  -- Archive industry gatherings 7 days after their end date
  WITH archived AS (
    UPDATE working_groups
    SET status = 'archived',
        updated_at = NOW()
    WHERE committee_type = 'industry_gathering'
      AND status = 'active'
      AND auto_archive_after_event = TRUE
      AND event_end_date IS NOT NULL
      AND event_end_date < CURRENT_DATE - INTERVAL '7 days'
    RETURNING name
  )
  SELECT COUNT(*)::INTEGER, ARRAY_AGG(name)
  INTO v_archived_count, v_archived_groups
  FROM archived;

  archived_count := v_archived_count;
  archived_groups := COALESCE(v_archived_groups, ARRAY[]::TEXT[]);

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION archive_past_industry_gatherings() IS 'Archives industry gathering groups 7 days after event end date';

-- Drop old function
DROP FUNCTION IF EXISTS archive_past_event_groups();
