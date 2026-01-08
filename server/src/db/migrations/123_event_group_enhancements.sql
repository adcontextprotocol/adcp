-- Migration: 123_event_group_enhancements.sql
-- Enhancements to event groups for industry gatherings like CES

-- =====================================================
-- ADD 'NOT_ATTENDING' TO INTEREST LEVEL
-- =====================================================
-- This allows tracking when someone declines so we don't ask again

ALTER TABLE working_group_memberships
DROP CONSTRAINT IF EXISTS wg_membership_interest_level_check;

ALTER TABLE working_group_memberships
ADD CONSTRAINT wg_membership_interest_level_check
CHECK (interest_level IS NULL OR interest_level IN ('maybe', 'interested', 'attending', 'attended', 'not_attending'));

COMMENT ON COLUMN working_group_memberships.interest_level IS 'For event groups: maybe, interested, attending, attended, not_attending';

-- =====================================================
-- ADD EVENT LOCATION FIELD
-- =====================================================
-- Distinct from 'region' which is for chapters
-- This stores display text like "Las Vegas, NV" for events

ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS event_location VARCHAR(255);

COMMENT ON COLUMN working_groups.event_location IS 'Display location for event-type committees (e.g., "Las Vegas, NV")';

-- =====================================================
-- UPDATE VIEW TO INCLUDE LOCATION
-- =====================================================
-- Need to drop and recreate because we're adding a column in the middle

DROP VIEW IF EXISTS upcoming_event_groups;
CREATE VIEW upcoming_event_groups AS
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
  e.title as event_title,
  e.venue_name,
  e.venue_city as event_city,
  e.venue_country as event_country,
  e.start_time as event_start_time,
  e.end_time as event_end_time,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active') as member_count,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active' AND m.interest_level = 'attending') as attending_count,
  (SELECT COUNT(*) FROM working_group_memberships m WHERE m.working_group_id = wg.id AND m.status = 'active' AND m.interest_level = 'not_attending') as declined_count
FROM working_groups wg
LEFT JOIN events e ON wg.linked_event_id = e.id
WHERE wg.committee_type = 'event'
  AND wg.status = 'active'
  AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)
ORDER BY wg.event_start_date ASC NULLS LAST;

COMMENT ON VIEW upcoming_event_groups IS 'Active event groups for upcoming or ongoing events with attendance counts';

-- =====================================================
-- FUNCTION: AUTO-ARCHIVE PAST EVENT GROUPS
-- =====================================================
-- Can be called by a cron job or scheduled task

CREATE OR REPLACE FUNCTION archive_past_event_groups()
RETURNS TABLE(
  archived_count INTEGER,
  archived_groups TEXT[]
) AS $$
DECLARE
  v_archived_count INTEGER := 0;
  v_archived_groups TEXT[] := '{}';
BEGIN
  -- Archive event groups where:
  -- 1. committee_type = 'event'
  -- 2. auto_archive_after_event = TRUE
  -- 3. event_end_date is more than 7 days ago
  -- 4. status is still 'active'

  WITH archived AS (
    UPDATE working_groups
    SET status = 'archived',
        updated_at = NOW()
    WHERE committee_type = 'event'
      AND auto_archive_after_event = TRUE
      AND event_end_date IS NOT NULL
      AND event_end_date < CURRENT_DATE - INTERVAL '7 days'
      AND status = 'active'
    RETURNING name
  )
  SELECT COUNT(*)::INTEGER, ARRAY_AGG(name)
  INTO v_archived_count, v_archived_groups
  FROM archived;

  RETURN QUERY SELECT v_archived_count, COALESCE(v_archived_groups, '{}');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION archive_past_event_groups IS 'Archives event groups 7 days after their end date';
