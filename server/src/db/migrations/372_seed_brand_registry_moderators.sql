-- Seed the brand-registry-moderators working group for logo review authorization
INSERT INTO working_groups (name, slug, description, committee_type, status, is_private, display_order)
VALUES (
  'Brand Registry Moderators',
  'brand-registry-moderators',
  'Members who review and approve community-submitted brand logos',
  'working_group',
  'active',
  true,
  100
)
ON CONFLICT (slug) DO NOTHING;
