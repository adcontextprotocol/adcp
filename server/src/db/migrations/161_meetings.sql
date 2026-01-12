-- Migration: 109_meetings.sql
-- Meeting management system for working groups
-- Supports recurring series, one-off meetings, topic-based subscriptions

-- =====================================================
-- TOPICS: Add topics to working groups
-- =====================================================

ALTER TABLE working_groups
ADD COLUMN IF NOT EXISTS topics JSONB DEFAULT '[]';

COMMENT ON COLUMN working_groups.topics IS 'Array of topic objects: [{slug, name, description}]';

-- =====================================================
-- TOPIC SUBSCRIPTIONS: Members subscribe to topics
-- =====================================================

CREATE TABLE IF NOT EXISTS working_group_topic_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which group and member
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  workos_user_id VARCHAR(255) NOT NULL,

  -- Which topics they're interested in
  topic_slugs TEXT[] NOT NULL DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- One subscription record per member per group
  CONSTRAINT unique_wg_topic_subscription UNIQUE(working_group_id, workos_user_id)
);

CREATE INDEX IF NOT EXISTS idx_wg_topic_subs_group ON working_group_topic_subscriptions(working_group_id);
CREATE INDEX IF NOT EXISTS idx_wg_topic_subs_user ON working_group_topic_subscriptions(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_wg_topic_subs_topics ON working_group_topic_subscriptions USING GIN(topic_slugs);

CREATE TRIGGER update_wg_topic_subscriptions_updated_at
  BEFORE UPDATE ON working_group_topic_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE working_group_topic_subscriptions IS 'Member topic preferences within working groups';
COMMENT ON COLUMN working_group_topic_subscriptions.topic_slugs IS 'Array of topic slugs the member wants to follow';

-- =====================================================
-- MEETING SERIES: Recurring meeting templates
-- =====================================================

CREATE TABLE IF NOT EXISTS meeting_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which working group owns this series
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Identity
  title VARCHAR(255) NOT NULL,
  description TEXT,

  -- Topics this series covers (for filtering invites)
  topic_slugs TEXT[] DEFAULT '{}',

  -- Schedule (for display and auto-generation)
  -- recurrence_rule follows iCal RRULE-like structure
  recurrence_rule JSONB,  -- {freq: 'weekly', interval: 2, byDay: ['TH']}
  default_start_time TIME,  -- 14:00:00
  duration_minutes INTEGER DEFAULT 60,
  timezone VARCHAR(100) DEFAULT 'America/New_York',

  -- Zoom settings (for recurring meeting)
  zoom_meeting_id VARCHAR(255),
  zoom_join_url TEXT,
  zoom_passcode VARCHAR(50),

  -- Google Calendar (for recurring event)
  google_calendar_id VARCHAR(255),
  google_event_series_id VARCHAR(255),

  -- Invitation behavior
  invite_mode VARCHAR(50) DEFAULT 'topic_subscribers'
    CHECK (invite_mode IN ('all_members', 'topic_subscribers', 'manual')),

  -- Status
  status VARCHAR(50) DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),

  -- Ownership
  created_by_user_id VARCHAR(255),

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_series_group ON meeting_series(working_group_id);
CREATE INDEX IF NOT EXISTS idx_meeting_series_status ON meeting_series(status);
CREATE INDEX IF NOT EXISTS idx_meeting_series_topics ON meeting_series USING GIN(topic_slugs);

CREATE TRIGGER update_meeting_series_updated_at
  BEFORE UPDATE ON meeting_series
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE meeting_series IS 'Recurring meeting templates for working groups';
COMMENT ON COLUMN meeting_series.recurrence_rule IS 'iCal-style rule: {freq, interval, byDay, count, until}';
COMMENT ON COLUMN meeting_series.invite_mode IS 'Who gets invited: all_members, topic_subscribers, or manual';

-- =====================================================
-- MEETINGS: Individual meeting occurrences
-- =====================================================

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent series (NULL for one-off meetings)
  series_id UUID REFERENCES meeting_series(id) ON DELETE SET NULL,

  -- Working group (denormalized for easier queries)
  working_group_id UUID NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,

  -- Identity
  title VARCHAR(255) NOT NULL,
  description TEXT,
  agenda TEXT,  -- Markdown agenda

  -- Topics (inherited from series or set directly)
  topic_slugs TEXT[] DEFAULT '{}',

  -- Timing
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  timezone VARCHAR(100) DEFAULT 'America/New_York',

  -- Zoom
  zoom_meeting_id VARCHAR(255),
  zoom_join_url TEXT,
  zoom_passcode VARCHAR(50),

  -- Google Calendar
  google_calendar_event_id VARCHAR(255),

  -- Recording and transcript (populated after meeting)
  recording_url TEXT,
  transcript_url TEXT,
  transcript_text TEXT,
  summary TEXT,  -- AI-generated summary

  -- Status
  status VARCHAR(50) DEFAULT 'scheduled'
    CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),

  -- Slack integration
  slack_channel_id VARCHAR(50),
  slack_thread_ts VARCHAR(50),
  slack_announcement_ts VARCHAR(50),

  -- Ownership
  created_by_user_id VARCHAR(255),

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meetings_series ON meetings(series_id);
CREATE INDEX IF NOT EXISTS idx_meetings_group ON meetings(working_group_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time);
CREATE INDEX IF NOT EXISTS idx_meetings_topics ON meetings USING GIN(topic_slugs);
CREATE INDEX IF NOT EXISTS idx_meetings_upcoming ON meetings(start_time)
  WHERE status = 'scheduled';

CREATE TRIGGER update_meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE meetings IS 'Individual meeting occurrences (from series or one-off)';
COMMENT ON COLUMN meetings.series_id IS 'Parent series if recurring, NULL for one-off meetings';
COMMENT ON COLUMN meetings.transcript_text IS 'Full transcript text for search/AI processing';
COMMENT ON COLUMN meetings.summary IS 'AI-generated meeting summary';

-- =====================================================
-- MEETING ATTENDEES: RSVP and attendance tracking
-- =====================================================

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which meeting
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,

  -- Who (one of these should be set)
  workos_user_id VARCHAR(255),
  email VARCHAR(255),  -- For non-members
  name VARCHAR(255),   -- Cached or provided for non-members

  -- RSVP status
  rsvp_status VARCHAR(50) DEFAULT 'pending'
    CHECK (rsvp_status IN ('pending', 'accepted', 'declined', 'tentative')),
  rsvp_at TIMESTAMP WITH TIME ZONE,
  rsvp_note TEXT,  -- "I'll be 5 min late"

  -- Attendance (populated during/after meeting)
  attended BOOLEAN,
  joined_at TIMESTAMP WITH TIME ZONE,
  left_at TIMESTAMP WITH TIME ZONE,

  -- How they were invited
  invite_source VARCHAR(50) DEFAULT 'auto'
    CHECK (invite_source IN ('auto', 'manual', 'request')),

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT unique_meeting_user UNIQUE(meeting_id, workos_user_id),
  CONSTRAINT unique_meeting_email UNIQUE(meeting_id, email)
);

CREATE INDEX IF NOT EXISTS idx_meeting_attendees_meeting ON meeting_attendees(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_user ON meeting_attendees(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_rsvp ON meeting_attendees(rsvp_status);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_attended ON meeting_attendees(meeting_id, attended)
  WHERE attended = TRUE;

CREATE TRIGGER update_meeting_attendees_updated_at
  BEFORE UPDATE ON meeting_attendees
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE meeting_attendees IS 'Meeting invitees with RSVP and attendance tracking';
COMMENT ON COLUMN meeting_attendees.invite_source IS 'How invited: auto (from subscription), manual, or request';

-- =====================================================
-- ADD TOPICS TO PERSPECTIVES (for tagging docs/notes)
-- =====================================================

ALTER TABLE perspectives
ADD COLUMN IF NOT EXISTS topic_slugs TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_perspectives_topics ON perspectives USING GIN(topic_slugs);

COMMENT ON COLUMN perspectives.topic_slugs IS 'Topic tags for filtering within working group';

-- =====================================================
-- VIEWS
-- =====================================================

-- Upcoming meetings with group info
CREATE OR REPLACE VIEW upcoming_meetings AS
SELECT
  m.id,
  m.series_id,
  m.working_group_id,
  m.title,
  m.description,
  m.topic_slugs,
  m.start_time,
  m.end_time,
  m.timezone,
  m.zoom_join_url,
  m.status,
  wg.name as working_group_name,
  wg.slug as working_group_slug,
  wg.committee_type,
  ms.title as series_title,
  (SELECT COUNT(*) FROM meeting_attendees ma
   WHERE ma.meeting_id = m.id AND ma.rsvp_status = 'accepted') as accepted_count,
  (SELECT COUNT(*) FROM meeting_attendees ma
   WHERE ma.meeting_id = m.id) as invited_count
FROM meetings m
JOIN working_groups wg ON wg.id = m.working_group_id
LEFT JOIN meeting_series ms ON ms.id = m.series_id
WHERE m.status = 'scheduled'
  AND m.start_time > NOW()
ORDER BY m.start_time ASC;

COMMENT ON VIEW upcoming_meetings IS 'Scheduled meetings in the future with group and RSVP counts';

-- Member's meetings (for "my meetings" view)
CREATE OR REPLACE VIEW member_upcoming_meetings AS
SELECT
  ma.workos_user_id,
  ma.rsvp_status,
  m.id as meeting_id,
  m.title,
  m.start_time,
  m.end_time,
  m.timezone,
  m.zoom_join_url,
  m.working_group_id,
  wg.name as working_group_name,
  wg.slug as working_group_slug
FROM meeting_attendees ma
JOIN meetings m ON m.id = ma.meeting_id
JOIN working_groups wg ON wg.id = m.working_group_id
WHERE m.status = 'scheduled'
  AND m.start_time > NOW()
  AND ma.rsvp_status != 'declined'
ORDER BY m.start_time ASC;

COMMENT ON VIEW member_upcoming_meetings IS 'Upcoming meetings for each member (not declined)';

-- Working group topic subscribers (for invite targeting)
CREATE OR REPLACE VIEW working_group_topic_members AS
SELECT
  wgm.working_group_id,
  wgm.workos_user_id,
  wgm.user_email,
  wgm.user_name,
  COALESCE(wgts.topic_slugs, '{}') as subscribed_topics
FROM working_group_memberships wgm
LEFT JOIN working_group_topic_subscriptions wgts
  ON wgts.working_group_id = wgm.working_group_id
  AND wgts.workos_user_id = wgm.workos_user_id
WHERE wgm.status = 'active';

COMMENT ON VIEW working_group_topic_members IS 'Active members with their topic subscriptions';
