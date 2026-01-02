-- Migration: 086_seed_committees.sql
-- Seed initial committees: industry councils and regional chapters

-- Insert Industry Councils
INSERT INTO working_groups (name, slug, description, committee_type, status, is_private, display_order)
VALUES
  ('Open Web Council', 'open-web-council', 'Advancing agentic advertising standards for the open web ecosystem, including display, native, and programmatic channels.', 'council', 'active', false, 10),
  ('CTV Council', 'ctv-council', 'Developing best practices and protocols for connected TV and streaming advertising in the agentic era.', 'council', 'active', false, 20),
  ('Retail Media Council', 'retail-media-council', 'Driving innovation in retail media networks through standardized agentic advertising interfaces.', 'council', 'active', false, 30),
  ('Policy Council', 'policy-council', 'Shaping industry policy, privacy frameworks, and regulatory guidance for AI-powered advertising.', 'council', 'active', false, 40)
ON CONFLICT (slug) DO UPDATE SET
  committee_type = EXCLUDED.committee_type,
  description = EXCLUDED.description;

-- Insert Regional Chapters
INSERT INTO working_groups (name, slug, description, committee_type, region, status, is_private, display_order)
VALUES
  ('New York Chapter', 'nyc-chapter', 'Connecting agentic advertising professionals in the New York metropolitan area.', 'chapter', 'New York', 'active', false, 100),
  ('London Chapter', 'london-chapter', 'Building the UK agentic advertising community centered in London.', 'chapter', 'London', 'active', false, 110),
  ('Paris Chapter', 'paris-chapter', 'Growing the French and European agentic advertising network from Paris.', 'chapter', 'Paris', 'active', false, 120),
  ('Amsterdam Chapter', 'amsterdam-chapter', 'Connecting agentic advertising innovators across the Netherlands and Benelux region.', 'chapter', 'Amsterdam', 'active', false, 130),
  ('Sydney Chapter', 'sydney-chapter', 'Building the Asia-Pacific agentic advertising community from Sydney.', 'chapter', 'Sydney', 'active', false, 140)
ON CONFLICT (slug) DO UPDATE SET
  committee_type = EXCLUDED.committee_type,
  region = EXCLUDED.region,
  description = EXCLUDED.description;
