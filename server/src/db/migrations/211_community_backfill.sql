-- Migration: 211_community_backfill.sql
-- Backfill community points from existing activity data
-- and auto-award badges based on thresholds.

-- =====================================================
-- AWARD POINTS FOR EXISTING WORKING GROUP MEMBERSHIPS
-- =====================================================

INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type)
SELECT
  wgm.workos_user_id,
  'wg_joined',
  15,
  wgm.working_group_id::text,
  'working_group'
FROM working_group_memberships wgm
WHERE wgm.status = 'active'
  AND wgm.workos_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = wgm.workos_user_id);

-- =====================================================
-- AWARD POINTS FOR EVENT ATTENDANCE
-- =====================================================

INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type)
SELECT
  er.workos_user_id,
  'event_attended',
  25,
  er.event_id::text,
  'event'
FROM event_registrations er
WHERE er.attended = true
  AND er.workos_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = er.workos_user_id);

-- =====================================================
-- AWARD POINTS FOR PUBLISHED PERSPECTIVES
-- =====================================================

INSERT INTO community_points (workos_user_id, action, points, reference_id, reference_type)
SELECT
  p.author_user_id,
  'content_published',
  50,
  p.id::text,
  'perspective'
FROM perspectives p
WHERE p.author_user_id IS NOT NULL
  AND p.status = 'published'
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = p.author_user_id);

-- =====================================================
-- AUTO-AWARD BADGES
-- =====================================================

-- Working group member badge: anyone in a working group
INSERT INTO user_badges (workos_user_id, badge_id)
SELECT DISTINCT wgm.workos_user_id, 'working_group_member'
FROM working_group_memberships wgm
WHERE wgm.status = 'active'
  AND wgm.workos_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = wgm.workos_user_id)
ON CONFLICT (workos_user_id, badge_id) DO NOTHING;

-- Event regular badge: attended 3+ events
INSERT INTO user_badges (workos_user_id, badge_id)
SELECT er.workos_user_id, 'event_regular'
FROM event_registrations er
WHERE er.attended = true
  AND er.workos_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = er.workos_user_id)
GROUP BY er.workos_user_id
HAVING COUNT(*) >= 3
ON CONFLICT (workos_user_id, badge_id) DO NOTHING;

-- Contributor badge: published content
INSERT INTO user_badges (workos_user_id, badge_id)
SELECT DISTINCT p.author_user_id, 'contributor'
FROM perspectives p
WHERE p.author_user_id IS NOT NULL
  AND p.status = 'published'
  AND EXISTS (SELECT 1 FROM users WHERE workos_user_id = p.author_user_id)
ON CONFLICT (workos_user_id, badge_id) DO NOTHING;
