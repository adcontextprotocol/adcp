-- Migration: 093_seed_working_groups_and_councils.sql
-- Seed the full set of working groups and industry councils

-- Insert Working Groups (committee_type = 'working_group')
INSERT INTO working_groups (name, slug, description, committee_type, status, is_private, display_order)
VALUES
  ('Technical Standards Working Group', 'technical-standards-wg', 'Define the foundational technical infrastructure that enables interoperability across the agentic advertising ecosystem. Develops and maintains core protocol specifications, authentication and authorization frameworks, API standards, and infrastructure requirements.', 'working_group', 'active', false, 1),
  ('Media Buying Protocol Working Group', 'media-buying-protocol-wg', 'Standardize how AI agents discover, evaluate, negotiate, and execute media buying transactions across channels and platforms. Defines workflows and message formats for the end-to-end media buying process in an agentic context.', 'working_group', 'active', false, 2),
  ('Brand Standards Working Group', 'brand-standards-wg', 'Establish standards for brand safety, brand suitability, and sustainability compliance in agentic advertising. Defines how brands articulate their requirements in machine-readable formats and how compliance is verified and reported.', 'working_group', 'active', false, 3),
  ('Creative Working Group', 'creative-wg', 'Define standards for how advertising creative is specified, delivered, adapted, and rendered in agentic contexts. Addresses the full creative lifecycle from asset format specifications through dynamic creative optimization and generative creative guidelines.', 'working_group', 'active', false, 4),
  ('Signals & Data Working Group', 'signals-data-wg', 'Standardize how audience signals, contextual data, and measurement information flow through the agentic advertising ecosystem. Defines privacy-compliant approaches to audience signaling, identity resolution, and measurement standards.', 'working_group', 'active', false, 5),
  ('Training & Education Working Group', 'training-education-wg', 'Develop educational resources and certification programs that enable practitioners to effectively participate in the agentic advertising ecosystem. Creates curricula, training materials, and certification frameworks.', 'working_group', 'active', false, 6),
  ('Events & Thought Leadership Working Group', 'events-thought-leadership-wg', 'Build community, drive awareness, and establish AgenticAdvertising.org as the authoritative voice on the future of AI-driven advertising. Coordinates regional chapters, organizes events, and develops thought leadership content.', 'working_group', 'active', false, 7)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  committee_type = EXCLUDED.committee_type,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order;

-- Insert missing Industry Councils (adding to existing ones from 086)
INSERT INTO working_groups (name, slug, description, committee_type, status, is_private, display_order)
VALUES
  ('Digital Audio Council', 'digital-audio-council', 'Advance agentic advertising adoption across podcasting, streaming audio, and digital radio. Addresses dynamic ad insertion, host-read integrations, and audio-specific measurement.', 'council', 'active', false, 22),
  ('Creator Economy Council', 'creator-economy-council', 'Enable agentic advertising within influencer marketing and creator-driven media. Explores creator partnerships, sponsorship matching, and performance measurement in creator-brand relationships.', 'council', 'active', false, 23),
  ('AI Surfaces Council', 'ai-surfaces-council', 'Define how advertising integrates into AI-native interfaces including chat assistants, conversational agents, and AI-powered discovery experiences. Addresses user experience, disclosure, and value exchange in conversational AI contexts.', 'council', 'active', false, 24),
  ('OOH Council', 'ooh-council', 'Accelerate agentic advertising adoption across out-of-home and digital out-of-home inventory. Addresses location targeting, dayparting, programmatic DOOH, and physical-world measurement.', 'council', 'active', false, 25),
  ('Brand & Agency Council', 'brand-agency-council', 'Represent marketer and agency perspectives in the development and adoption of agentic advertising standards. Ensures AdCP standards address advertiser needs from campaign planning through measurement and optimization.', 'council', 'active', false, 26)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  committee_type = EXCLUDED.committee_type,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order;

-- Update existing CTV Council to have more complete name and description (seeded as 'CTV Council' in 086)
UPDATE working_groups
SET
  name = 'CTV & Streaming Council',
  description = 'Drive agentic advertising adoption across connected TV, streaming, and video entertainment platforms. Addresses requirements of living-room and long-form video advertising including VAST, SSAI, ACR, and gaming.'
WHERE slug = 'ctv-council';

-- Remove duplicate if it exists from previous run of this migration
DELETE FROM working_groups WHERE slug = 'ctv-streaming-council';
