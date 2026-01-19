-- SI Test Data Seed Script
-- Creates member profiles with SI enabled for local testing
-- Can be rerun safely (uses ON CONFLICT)

-- ============================================================================
-- Test Organizations
-- ============================================================================

INSERT INTO organizations (workos_organization_id, name, company_type, subscription_status, created_at)
VALUES
  ('org_test_scope3', 'Scope3', 'adtech', 'active', NOW()),
  ('org_test_thetradedesk', 'The Trade Desk', 'adtech', 'active', NOW()),
  ('org_test_liveramp', 'LiveRamp', 'data', 'active', NOW()),
  ('org_test_pubmatic', 'PubMatic', 'adtech', 'active', NOW())
ON CONFLICT (workos_organization_id) DO UPDATE SET
  name = EXCLUDED.name,
  subscription_status = EXCLUDED.subscription_status,
  updated_at = NOW();

-- ============================================================================
-- Member Profiles with SI Enabled
-- ============================================================================

-- Scope3 - Sustainability/Carbon measurement
INSERT INTO member_profiles (
  id,
  workos_organization_id,
  display_name,
  slug,
  tagline,
  description,
  logo_url,
  brand_color,
  contact_email,
  contact_website,
  offerings,
  is_public,
  si_enabled,
  si_endpoint_url,
  si_capabilities,
  si_prompt_template
) VALUES (
  'a1b2c3d4-0001-4000-8000-000000000001',
  'org_test_scope3',
  'Scope3',
  'scope3',
  'Decarbonize your digital advertising',
  'Scope3 is the industry standard for measuring and reducing the carbon emissions of digital advertising. Our platform provides comprehensive carbon measurement across the entire digital supply chain, helping advertisers, agencies, and publishers meet their sustainability goals.',
  'https://www.scope3.com/images/scope3-logo.svg',
  '#00C853',
  'hello@scope3.com',
  'https://www.scope3.com',
  ARRAY['Carbon Measurement', 'Supply Path Optimization', 'Green Media Products', 'Sustainability Reporting', 'Carbon Calculator'],
  true,
  true,
  NULL,  -- Uses default SI agent
  '{"modalities": {"conversational": true}, "components": {"standard": ["text", "link", "image", "product_card", "carousel", "action_button"]}, "commerce": {"acp_checkout": false}}',
  E'You are the AI assistant for Scope3, the leading platform for measuring and reducing carbon emissions in digital advertising.\n\nKey facts about Scope3:\n- Founded in 2021 by Brian O''Kelley (former AppNexus CEO)\n- Measures carbon emissions across the entire digital ad supply chain\n- Partners with major DSPs, SSPs, and agencies\n- Provides actionable insights to reduce advertising''s carbon footprint\n- Aligned with the Global Media Sustainability Framework (GMSF)\n\nYour role is to help users understand:\n1. How digital advertising contributes to carbon emissions\n2. How Scope3 measures and reports on emissions\n3. What actions they can take to reduce their carbon footprint\n4. Our products: Green Media Products (GMPs), Supply Path Optimization, Carbon Calculator\n\nBe knowledgeable, passionate about sustainability, and helpful. Guide users toward taking action on their sustainability goals.'
) ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  logo_url = EXCLUDED.logo_url,
  brand_color = EXCLUDED.brand_color,
  contact_email = EXCLUDED.contact_email,
  contact_website = EXCLUDED.contact_website,
  offerings = EXCLUDED.offerings,
  is_public = EXCLUDED.is_public,
  si_enabled = EXCLUDED.si_enabled,
  si_capabilities = EXCLUDED.si_capabilities,
  si_prompt_template = EXCLUDED.si_prompt_template,
  updated_at = NOW();

-- The Trade Desk - DSP
INSERT INTO member_profiles (
  id,
  workos_organization_id,
  display_name,
  slug,
  tagline,
  description,
  logo_url,
  brand_color,
  contact_email,
  contact_website,
  offerings,
  is_public,
  si_enabled,
  si_capabilities
) VALUES (
  'a1b2c3d4-0002-4000-8000-000000000002',
  'org_test_thetradedesk',
  'The Trade Desk',
  'the-trade-desk',
  'A media buying platform built for the open internet',
  'The Trade Desk is a technology company that empowers buyers of advertising. Through its self-service, cloud-based platform, ad buyers can create, manage, and optimize digital advertising campaigns across ad formats and devices.',
  'https://www.thetradedesk.com/assets/global/ttd-logo.svg',
  '#0052CC',
  'info@thetradedesk.com',
  'https://www.thetradedesk.com',
  ARRAY['Programmatic Advertising', 'Connected TV', 'Audio Advertising', 'Retail Media', 'UID2'],
  true,
  true,
  '{"modalities": {"conversational": true}, "components": {"standard": ["text", "link", "product_card", "carousel", "action_button"]}}'
) ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  brand_color = EXCLUDED.brand_color,
  offerings = EXCLUDED.offerings,
  si_enabled = EXCLUDED.si_enabled,
  si_capabilities = EXCLUDED.si_capabilities,
  updated_at = NOW();

-- LiveRamp - Data connectivity
INSERT INTO member_profiles (
  id,
  workos_organization_id,
  display_name,
  slug,
  tagline,
  description,
  logo_url,
  brand_color,
  contact_email,
  contact_website,
  offerings,
  is_public,
  si_enabled,
  si_capabilities
) VALUES (
  'a1b2c3d4-0003-4000-8000-000000000003',
  'org_test_liveramp',
  'LiveRamp',
  'liveramp',
  'Data connectivity for the modern marketer',
  'LiveRamp is the leading data connectivity platform. We connect people, data, and devices across the digital and physical world, enabling companies to better connect with their customers.',
  'https://liveramp.com/wp-content/uploads/2021/01/liveramp-logo.svg',
  '#FF6B00',
  'info@liveramp.com',
  'https://liveramp.com',
  ARRAY['Identity Resolution', 'Data Marketplace', 'Data Collaboration', 'Authenticated Traffic Solution', 'RampID'],
  true,
  true,
  '{"modalities": {"conversational": true}, "components": {"standard": ["text", "link", "product_card", "action_button"]}}'
) ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  brand_color = EXCLUDED.brand_color,
  offerings = EXCLUDED.offerings,
  si_enabled = EXCLUDED.si_enabled,
  si_capabilities = EXCLUDED.si_capabilities,
  updated_at = NOW();

-- PubMatic - SSP
INSERT INTO member_profiles (
  id,
  workos_organization_id,
  display_name,
  slug,
  tagline,
  description,
  logo_url,
  brand_color,
  contact_email,
  contact_website,
  offerings,
  is_public,
  si_enabled,
  si_capabilities
) VALUES (
  'a1b2c3d4-0004-4000-8000-000000000004',
  'org_test_pubmatic',
  'PubMatic',
  'pubmatic',
  'The future of programmatic, delivered',
  'PubMatic delivers superior revenue to publishers by being a sell-side platform of choice for agencies and advertisers. Our cloud infrastructure platform provides real-time analytics and programmatic advertising solutions.',
  'https://pubmatic.com/wp-content/uploads/2020/01/pubmatic-logo.svg',
  '#6366F1',
  'info@pubmatic.com',
  'https://pubmatic.com',
  ARRAY['SSP Platform', 'Header Bidding', 'Identity Hub', 'Audience Encore', 'OpenWrap'],
  true,
  true,
  '{"modalities": {"conversational": true}, "components": {"standard": ["text", "link", "product_card", "action_button"]}}'
) ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  brand_color = EXCLUDED.brand_color,
  offerings = EXCLUDED.offerings,
  si_enabled = EXCLUDED.si_enabled,
  si_capabilities = EXCLUDED.si_capabilities,
  updated_at = NOW();

-- ============================================================================
-- SI Skills for Members
-- ============================================================================

-- Scope3 Skills
INSERT INTO si_skills (member_profile_id, skill_name, skill_description, skill_type, config)
VALUES
  ('a1b2c3d4-0001-4000-8000-000000000001', 'request_demo', 'Request a demo of Scope3 platform', 'demo_request',
   '{"calendar_link": "https://www.scope3.com/demo", "confirmation_message": "Great! Our team will reach out to schedule your personalized demo."}'),
  ('a1b2c3d4-0001-4000-8000-000000000001', 'carbon_calculator', 'Calculate carbon footprint of a campaign', 'custom',
   '{"tool_url": "https://www.scope3.com/calculator"}'),
  ('a1b2c3d4-0001-4000-8000-000000000001', 'view_docs', 'View Scope3 documentation and resources', 'documentation',
   '{"docs_url": "https://www.scope3.com/resources"}'),
  ('a1b2c3d4-0001-4000-8000-000000000001', 'contact_sales', 'Connect with Scope3 sales team', 'contact_sales',
   '{"sales_email": "sales@scope3.com"}')
ON CONFLICT (member_profile_id, skill_name) DO UPDATE SET
  skill_description = EXCLUDED.skill_description,
  config = EXCLUDED.config,
  updated_at = NOW();

-- The Trade Desk Skills
INSERT INTO si_skills (member_profile_id, skill_name, skill_description, skill_type, config)
VALUES
  ('a1b2c3d4-0002-4000-8000-000000000002', 'request_demo', 'Request a demo of The Trade Desk platform', 'demo_request',
   '{"calendar_link": "https://www.thetradedesk.com/contact"}'),
  ('a1b2c3d4-0002-4000-8000-000000000002', 'view_docs', 'Access The Trade Desk Edge Academy', 'documentation',
   '{"docs_url": "https://www.thetradedesk.com/edge-academy"}'),
  ('a1b2c3d4-0002-4000-8000-000000000002', 'contact_sales', 'Connect with TTD sales team', 'contact_sales',
   '{"sales_email": "sales@thetradedesk.com"}')
ON CONFLICT (member_profile_id, skill_name) DO UPDATE SET
  skill_description = EXCLUDED.skill_description,
  config = EXCLUDED.config,
  updated_at = NOW();

-- LiveRamp Skills
INSERT INTO si_skills (member_profile_id, skill_name, skill_description, skill_type, config)
VALUES
  ('a1b2c3d4-0003-4000-8000-000000000003', 'request_demo', 'Request a LiveRamp demo', 'demo_request',
   '{"calendar_link": "https://liveramp.com/contact/"}'),
  ('a1b2c3d4-0003-4000-8000-000000000003', 'view_docs', 'Access LiveRamp documentation', 'documentation',
   '{"docs_url": "https://docs.liveramp.com/"}'),
  ('a1b2c3d4-0003-4000-8000-000000000003', 'signup', 'Sign up for LiveRamp', 'signup',
   '{"redirect_url": "https://liveramp.com/get-started/"}')
ON CONFLICT (member_profile_id, skill_name) DO UPDATE SET
  skill_description = EXCLUDED.skill_description,
  config = EXCLUDED.config,
  updated_at = NOW();

-- PubMatic Skills
INSERT INTO si_skills (member_profile_id, skill_name, skill_description, skill_type, config)
VALUES
  ('a1b2c3d4-0004-4000-8000-000000000004', 'request_demo', 'Request a PubMatic platform demo', 'demo_request',
   '{"calendar_link": "https://pubmatic.com/contact/"}'),
  ('a1b2c3d4-0004-4000-8000-000000000004', 'view_docs', 'Access PubMatic developer docs', 'documentation',
   '{"docs_url": "https://pubmatic.com/developers/"}'),
  ('a1b2c3d4-0004-4000-8000-000000000004', 'implementation_help', 'Get help with PubMatic integration', 'implementation_help',
   '{}')
ON CONFLICT (member_profile_id, skill_name) DO UPDATE SET
  skill_description = EXCLUDED.skill_description,
  config = EXCLUDED.config,
  updated_at = NOW();

-- ============================================================================
-- Verification Query
-- ============================================================================

SELECT
  mp.slug,
  mp.display_name,
  mp.si_enabled,
  mp.brand_color,
  COUNT(s.id) as skill_count
FROM member_profiles mp
LEFT JOIN si_skills s ON s.member_profile_id = mp.id
WHERE mp.si_enabled = true
GROUP BY mp.id
ORDER BY mp.display_name;
