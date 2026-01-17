-- Migration: 176_add_allocation_perspective.sql
-- Adds "Agentic Advertising is for Allocation" perspective by Brian O'Kelley

INSERT INTO perspectives (
  slug,
  content_type,
  title,
  subtitle,
  category,
  excerpt,
  external_url,
  external_site_name,
  author_name,
  status,
  published_at,
  display_order,
  tags
) VALUES (
  'agentic-advertising-is-for-allocation',
  'link',
  'Agentic Advertising is for Allocation',
  '"OpenRTB is a protocol for day trading; AdCP is a protocol for investing" - Benjamin Masse',
  'Op-Ed',
  'Programmatic advertising emerged to solve a specific challenge: determining which ad network would pay the most for a given impression. Yet premium publishers and brand advertisers face fundamentally different questions—ones more aligned with capacity-constrained markets like hotels or airlines. How should limited inventory or budget be allocated to maximize returns?',
  'https://bokonads.com/p/agentic-advertising-is-for-allocation',
  'BOK on Ads',
  'Brian O''Kelley',
  'published',
  '2026-01-11 00:00:00+00',
  0,
  ARRAY['op-ed', 'allocation', 'AdCP', 'OpenRTB', 'thought-leadership']
) ON CONFLICT (slug) DO NOTHING;

-- Update display_order for existing perspectives to shift them down
UPDATE perspectives
SET display_order = display_order + 1
WHERE slug != 'agentic-advertising-is-for-allocation'
  AND display_order >= 0;
