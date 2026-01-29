-- Seed sales agents into member profiles
-- Adds public AdCP reference implementation as a registered sales agent

-- Create organization and member profile for the AdCP Reference Implementation
-- This provides a public sales agent for the registry at /registry?type=sales
-- UUID is well-known and stable for the reference implementation
INSERT INTO organizations (workos_organization_id, name, company_type, subscription_status, created_at)
VALUES ('org_adcp_reference', 'AdCP Reference Implementation', 'adtech', 'active', NOW())
ON CONFLICT (workos_organization_id) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = NOW();

INSERT INTO member_profiles (
  id,
  workos_organization_id,
  display_name,
  slug,
  tagline,
  description,
  contact_website,
  offerings,
  agents,
  is_public,
  show_in_carousel
) VALUES (
  'a1b2c3d4-adc0-4000-8000-000000000000',  -- Well-known UUID for reference implementation
  'org_adcp_reference',
  'AdCP Reference Implementation',
  'adcp-reference',
  'Public testing platform for AdCP protocol',
  'The official AdCP reference implementation for testing and development. Supports all AdCP tasks including get_products, create_media_buy, list_creative_formats, and more.',
  'https://adcontextprotocol.org',
  ARRAY['sales_agent', 'creative_agent']::text[],
  '[
    {
      "url": "https://test-agent.adcontextprotocol.org",
      "is_public": true,
      "type": "sales",
      "name": "AdCP Test Agent"
    },
    {
      "url": "https://creatives.adcontextprotocol.org",
      "is_public": true,
      "type": "creative",
      "name": "AdCP Creative Formats"
    }
  ]'::jsonb,
  true,
  true
) ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  offerings = EXCLUDED.offerings,
  agents = EXCLUDED.agents,
  is_public = EXCLUDED.is_public,
  show_in_carousel = EXCLUDED.show_in_carousel,
  updated_at = NOW();
