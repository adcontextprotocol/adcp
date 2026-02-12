-- Migration: 202_manifest_references.sql
-- Purpose: Refactor brand/property registries to store references (URLs or agent pointers)
--          instead of hosting actual manifest content
--
-- This supports member-contributed references where members host their own manifests
-- and we maintain a directory of pointers to them.

-- Create manifest_references table (additional index alongside existing brand/property tables)
-- NOTE: discovered_brands, hosted_brands, hosted_properties remain in use
-- Stores pointers to member-hosted manifests (either URL or agent reference)
CREATE TABLE manifest_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What this reference is for
  domain TEXT NOT NULL,                        -- Domain this manifest covers (e.g., "nike.com")
  manifest_type TEXT NOT NULL,                 -- 'brand.json' or 'adagents.json'

  -- Reference type (discriminated union)
  -- Either manifest_url OR (agent_url + agent_id) should be set, not both
  reference_type TEXT NOT NULL CHECK (reference_type IN ('url', 'agent')),

  -- For URL references: direct link to hosted manifest
  manifest_url TEXT,

  -- For agent references: MCP agent that provides the manifest
  agent_url TEXT,
  agent_id TEXT,                               -- brand_id or property_id to pass to agent

  -- Who contributed this reference
  contributed_by_org_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,
  contributed_by_user_id VARCHAR(255),
  contributed_by_email VARCHAR(255),

  -- Metadata for ranking when multiple references exist
  completeness_score INTEGER DEFAULT 0,        -- 0-100, higher = more complete
  last_verified_at TIMESTAMPTZ,                -- When we last verified the URL/agent works
  verification_status TEXT DEFAULT 'pending',  -- pending, valid, invalid, unreachable

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_url_reference CHECK (
    reference_type != 'url' OR manifest_url IS NOT NULL
  ),
  CONSTRAINT valid_agent_reference CHECK (
    reference_type != 'agent' OR (agent_url IS NOT NULL AND agent_id IS NOT NULL)
  ),
  -- One org can only contribute one reference per domain/type combo
  UNIQUE(domain, manifest_type, contributed_by_org_id)
);

-- Indexes for efficient lookups
CREATE INDEX idx_manifest_refs_domain ON manifest_references(domain);
CREATE INDEX idx_manifest_refs_type ON manifest_references(manifest_type);
CREATE INDEX idx_manifest_refs_domain_type ON manifest_references(domain, manifest_type);
CREATE INDEX idx_manifest_refs_org ON manifest_references(contributed_by_org_id);
CREATE INDEX idx_manifest_refs_verified ON manifest_references(verification_status, last_verified_at);
CREATE INDEX idx_manifest_refs_score ON manifest_references(completeness_score DESC);

-- Trigger for updated_at
CREATE TRIGGER update_manifest_references_updated_at
  BEFORE UPDATE ON manifest_references
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create view for best reference per domain (highest score, most recently verified)
CREATE VIEW best_manifest_references AS
SELECT DISTINCT ON (domain, manifest_type)
  mr.*
FROM manifest_references mr
WHERE mr.verification_status = 'valid'
ORDER BY
  domain,
  manifest_type,
  completeness_score DESC,
  last_verified_at DESC NULLS LAST;

-- Comment for documentation
COMMENT ON TABLE manifest_references IS 'Directory of member-contributed manifest references. Members host their own brand.json/adagents.json files and register pointers here.';
COMMENT ON COLUMN manifest_references.reference_type IS 'url = direct link to hosted file; agent = MCP agent that provides manifest dynamically';
COMMENT ON COLUMN manifest_references.completeness_score IS 'Quality score (0-100) based on how complete the manifest is. Used for ranking when multiple refs exist.';
