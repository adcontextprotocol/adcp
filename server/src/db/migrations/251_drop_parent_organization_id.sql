-- Migration: 246_drop_parent_organization_id.sql
-- Parent/subsidiary relationships are derived from the brand registry:
-- organizations.email_domain → discovered_brands.domain → discovered_brands.house_domain → organizations.email_domain

DROP INDEX IF EXISTS idx_organizations_parent;
ALTER TABLE organizations DROP COLUMN IF EXISTS parent_organization_id;
