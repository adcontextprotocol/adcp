-- Migration: 192_hosted_properties.sql
-- Purpose: Hosted properties for synthetic adagents.json we create/manage
-- Mirrors hosted_brands pattern - allows Addie to create property records for
-- publishers that don't self-host their adagents.json

-- Hosted properties (synthetic adagents.json we manage)
CREATE TABLE hosted_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner (optional - free users can create without org)
  workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,
  created_by_user_id VARCHAR(255),
  created_by_email VARCHAR(255),

  -- Property identification
  publisher_domain TEXT NOT NULL UNIQUE,  -- The domain this property represents

  -- Full adagents.json content
  adagents_json JSONB NOT NULL,

  -- Domain verification (proves ownership)
  domain_verified BOOLEAN DEFAULT FALSE,
  verification_token TEXT,  -- Token to place in DNS TXT or .well-known

  -- Visibility
  is_public BOOLEAN DEFAULT TRUE,  -- Show in property registry

  -- Source tracking
  source_type TEXT DEFAULT 'community',  -- community, enriched

  -- Lifecycle
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add source_type to discovered_properties for tracking origin
ALTER TABLE discovered_properties ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'adagents_json';

-- Indexes for hosted_properties
CREATE INDEX idx_hosted_properties_org ON hosted_properties(workos_organization_id);
CREATE INDEX idx_hosted_properties_domain ON hosted_properties(publisher_domain);
CREATE INDEX idx_hosted_properties_created_by ON hosted_properties(created_by_email);
CREATE INDEX idx_hosted_properties_public ON hosted_properties(is_public) WHERE is_public = TRUE;
CREATE INDEX idx_hosted_properties_source ON hosted_properties(source_type);

-- Trigger for updated_at on hosted_properties
CREATE TRIGGER update_hosted_properties_updated_at
  BEFORE UPDATE ON hosted_properties
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
