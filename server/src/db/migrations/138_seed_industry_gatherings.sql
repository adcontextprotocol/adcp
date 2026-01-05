-- Migration: 138_seed_industry_gatherings.sql
-- Seed industry gatherings (external events like CES, Cannes Lions)
-- These are committee-like groups where members coordinate attendance/activities at major industry events

-- Insert CES 2026
INSERT INTO working_groups (
  name, slug, description, committee_type, status, is_private, display_order,
  event_start_date, event_end_date, auto_archive_after_event,
  logo_url, website_url
)
VALUES (
  'CES 2026',
  'ces-2026',
  'Connect with AgenticAdvertising.org members attending CES 2026 in Las Vegas. Coordinate meetups, share schedules, and network with fellow members at the world''s most influential tech event.',
  'industry_gathering',
  'active',
  false,
  100,
  '2026-01-07',
  '2026-01-10',
  true,
  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/CES_logo.svg/300px-CES_logo.svg.png',
  'https://www.ces.tech/'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  event_start_date = EXCLUDED.event_start_date,
  event_end_date = EXCLUDED.event_end_date,
  logo_url = EXCLUDED.logo_url,
  website_url = EXCLUDED.website_url;

-- Insert Cannes Lions 2026
INSERT INTO working_groups (
  name, slug, description, committee_type, status, is_private, display_order,
  event_start_date, event_end_date, auto_archive_after_event,
  logo_url, website_url
)
VALUES (
  'Cannes Lions 2026',
  'cannes-lions-2026',
  'Join AgenticAdvertising.org members at the Cannes Lions International Festival of Creativity. Network, attend sessions together, and explore the future of advertising creativity.',
  'industry_gathering',
  'active',
  false,
  101,
  '2026-06-15',
  '2026-06-19',
  true,
  'https://www.canneslions.com/images/canneslions-logo.svg',
  'https://www.canneslions.com/'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  event_start_date = EXCLUDED.event_start_date,
  event_end_date = EXCLUDED.event_end_date,
  logo_url = EXCLUDED.logo_url,
  website_url = EXCLUDED.website_url;

-- Make the dev leader user a leader of CES 2026
INSERT INTO working_group_leaders (working_group_id, user_id)
SELECT wg.id, 'user_dev_leader_001'
FROM working_groups wg
WHERE wg.slug = 'ces-2026'
ON CONFLICT (working_group_id, user_id) DO NOTHING;

-- Also make them a member
INSERT INTO working_group_memberships (working_group_id, workos_user_id, status, joined_at)
SELECT wg.id, 'user_dev_leader_001', 'active', NOW()
FROM working_groups wg
WHERE wg.slug = 'ces-2026'
ON CONFLICT (working_group_id, workos_user_id) DO NOTHING;
