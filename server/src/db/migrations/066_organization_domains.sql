-- Migration: 066_organization_domains.sql
-- Create organization_domains table for many-to-many relationship
--
-- This tracks domains associated with organizations for:
-- 1. User routing (which org does jane@acme.com belong to?)
-- 2. Enrichment lookups (Lusha company data)
-- 3. Handling mergers/acquisitions (multiple domains per org)
--
-- Synced from WorkOS via webhooks (organization.created, organization.updated)

-- Also add email_domain column to organizations for quick primary domain lookup
-- This is kept in sync with organization_domains.is_primary
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_domain VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_organizations_email_domain ON organizations(email_domain) WHERE email_domain IS NOT NULL;
COMMENT ON COLUMN organizations.email_domain IS 'Primary email domain, synced from organization_domains where is_primary=true';

CREATE TABLE IF NOT EXISTS organization_domains (
  id SERIAL PRIMARY KEY,
  workos_organization_id VARCHAR(255) NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  domain VARCHAR(255) NOT NULL,
  is_primary BOOLEAN DEFAULT false,
  verified BOOLEAN DEFAULT false,
  source VARCHAR(50) DEFAULT 'manual', -- 'workos', 'manual', 'import'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Each domain can only belong to one org
  UNIQUE(domain)
);

-- Index for looking up org by domain (user routing)
CREATE INDEX IF NOT EXISTS idx_organization_domains_domain ON organization_domains(domain);

-- Index for looking up domains by org
CREATE INDEX IF NOT EXISTS idx_organization_domains_org ON organization_domains(workos_organization_id);

-- Index for finding primary domain per org
CREATE INDEX IF NOT EXISTS idx_organization_domains_primary ON organization_domains(workos_organization_id, is_primary) WHERE is_primary = true;

COMMENT ON TABLE organization_domains IS 'Domains associated with organizations for user routing and enrichment';
COMMENT ON COLUMN organization_domains.is_primary IS 'Primary domain used for enrichment lookups';
COMMENT ON COLUMN organization_domains.verified IS 'Whether domain ownership has been verified via WorkOS';
COMMENT ON COLUMN organization_domains.source IS 'How the domain was added: workos (webhook), manual (admin), import (CSV migration)';
