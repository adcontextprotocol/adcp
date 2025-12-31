-- Migration: 066_add_email_domain.sql
-- Add email_domain column for Lusha enrichment lookups
--
-- This is separate from WorkOS domains which are used for authentication/SSO.
-- email_domain is a simple lookup key for enrichment services like Lusha.
-- For prospects (orgs without users), we can't rely on verified WorkOS domains,
-- so we store the domain here to enable auto-enrichment when prospects are created.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_domain VARCHAR(255);

-- Index for domain lookups
CREATE INDEX IF NOT EXISTS idx_organizations_email_domain ON organizations(email_domain) WHERE email_domain IS NOT NULL;

COMMENT ON COLUMN organizations.email_domain IS 'Primary email domain for the organization, used for enrichment and user matching';
