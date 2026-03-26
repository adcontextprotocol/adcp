-- Migration: Seed kitchen-cabinet governance group locally
-- This group already exists in production. This migration ensures local dev
-- environments have it so the kitchen-cabinet slug can be resolved.

INSERT INTO working_groups (name, slug, committee_type, is_private, status)
VALUES ('Kitchen Cabinet', 'kitchen-cabinet', 'governance', true, 'active')
ON CONFLICT (slug) DO NOTHING;
