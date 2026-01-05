-- Migration: 135_seed_dev_committee_leader.sql
-- Set up dev leader user as a leader of the Technical Standards Working Group
-- This is only for local development testing

-- Insert the dev leader user into working_group_leaders table
-- Makes them a leader of the Technical Standards Working Group
INSERT INTO working_group_leaders (working_group_id, user_id)
SELECT
  wg.id,
  'user_dev_leader_001'
FROM working_groups wg
WHERE wg.slug = 'technical-standards-wg'
ON CONFLICT (working_group_id, user_id) DO NOTHING;

-- Also make them a member of the working group
INSERT INTO working_group_memberships (working_group_id, workos_user_id, status, joined_at)
SELECT
  wg.id,
  'user_dev_leader_001',
  'active',
  NOW()
FROM working_groups wg
WHERE wg.slug = 'technical-standards-wg'
ON CONFLICT (working_group_id, workos_user_id) DO NOTHING;

-- Also make the dev member user a member of a working group for testing
INSERT INTO working_group_memberships (working_group_id, workos_user_id, status, joined_at)
SELECT
  wg.id,
  'user_dev_member_001',
  'active',
  NOW()
FROM working_groups wg
WHERE wg.slug = 'creative-wg'
ON CONFLICT (working_group_id, workos_user_id) DO NOTHING;
