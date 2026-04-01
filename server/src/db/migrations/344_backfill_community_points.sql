-- Migration: 338_backfill_community_points.sql
-- Backfill community_points from existing activity data.
-- Deletes existing backfill rows first to ensure consistent point values,
-- then re-inserts at canonical values. Safe to run multiple times.

-- 0. Clear existing backfill rows so point values are consistent.
-- Only deletes actions that are backfill-able (not daily_visit etc.)
DELETE FROM community_points
WHERE action IN (
  'wg_joined', 'event_registered', 'event_attended',
  'content_published', 'connection_made',
  'meeting_rsvp_accepted', 'wg_leadership', 'topic_subscribed',
  'github_linked'
);

-- 1. Working group memberships: 10 points each
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  wgm.workos_user_id,
  'wg_joined',
  10,
  wgm.working_group_id::text,
  'working_group',
  wgm.joined_at
FROM working_group_memberships wgm
WHERE wgm.workos_user_id IS NOT NULL
  AND wgm.status = 'active'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 2. Event registrations: 5 points each
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  er.workos_user_id,
  'event_registered',
  5,
  er.event_id::text,
  'event',
  er.registered_at
FROM event_registrations er
WHERE er.workos_user_id IS NOT NULL
  AND er.registration_status = 'registered'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 3. Event attendance: 25 points each (on top of registration)
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  er.workos_user_id,
  'event_attended',
  25,
  er.event_id::text,
  'event',
  COALESCE(er.checked_in_at, er.updated_at)
FROM event_registrations er
WHERE er.workos_user_id IS NOT NULL
  AND er.attended = TRUE
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 4. Published perspectives: 50 points each
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  p.author_user_id,
  'content_published',
  50,
  p.id::text,
  'perspective',
  COALESCE(p.published_at, p.created_at)
FROM perspectives p
WHERE p.author_user_id IS NOT NULL
  AND p.status = 'published'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 5. Accepted connections: 10 points each (both sides)
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  c.requester_user_id,
  'connection_made',
  10,
  c.id::text,
  'connection',
  COALESCE(c.responded_at, c.created_at)
FROM connections c
WHERE c.status = 'accepted'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  c.recipient_user_id,
  'connection_made',
  10,
  c.id::text,
  'connection',
  COALESCE(c.responded_at, c.created_at)
FROM connections c
WHERE c.status = 'accepted'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 6. Meeting RSVPs: 5 points each
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  ma.workos_user_id,
  'meeting_rsvp_accepted',
  5,
  ma.meeting_id::text,
  'meeting',
  COALESCE(ma.rsvp_at, ma.created_at)
FROM meeting_attendees ma
WHERE ma.workos_user_id IS NOT NULL
  AND ma.rsvp_status = 'accepted'
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 7. Working group leadership: 30 points each
-- working_group_leaders.user_id may be a Slack ID, so join through slack_user_mappings
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  COALESCE(sm.workos_user_id, wgl.user_id),
  'wg_leadership',
  30,
  wgl.working_group_id::text,
  'working_group',
  wgl.created_at
FROM working_group_leaders wgl
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = wgl.user_id
WHERE COALESCE(sm.workos_user_id, wgl.user_id) IN (SELECT workos_user_id FROM users)
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 8. Topic subscriptions: 5 points per group subscribed
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  wgts.workos_user_id,
  'topic_subscribed',
  5,
  wgts.working_group_id::text,
  'working_group',
  wgts.created_at
FROM working_group_topic_subscriptions wgts
WHERE wgts.workos_user_id IS NOT NULL
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;

-- 9. GitHub linked: 10 points each
INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type, created_at)
SELECT
  u.workos_user_id,
  'github_linked',
  10,
  u.github_username,
  'github',
  u.updated_at
FROM users u
WHERE u.github_username IS NOT NULL
  AND u.github_username != ''
ON CONFLICT (workos_user_id, action, reference_id) WHERE reference_id IS NOT NULL
DO NOTHING;
