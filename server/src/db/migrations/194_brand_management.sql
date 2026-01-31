-- Migration: 190_brand_management.sql
-- Purpose: Brand Protocol infrastructure for hosted and discovered brands
-- Parallels discovered_properties pattern for buy-side brand discovery

-- Hosted brands (for users who don't self-host brand.json)
-- Users can create brands via the API and get a redirect URL to place on their domain
CREATE TABLE hosted_brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner (optional - free users can create without org)
  workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,
  created_by_user_id VARCHAR(255),
  created_by_email VARCHAR(255),

  -- Brand identification
  brand_domain TEXT NOT NULL UNIQUE,  -- The domain this brand represents

  -- Full brand.json content (House Portfolio variant)
  brand_json JSONB NOT NULL,

  -- Domain verification (proves ownership)
  domain_verified BOOLEAN DEFAULT FALSE,
  verification_token TEXT,  -- Token to place in DNS TXT or .well-known

  -- Visibility
  is_public BOOLEAN DEFAULT TRUE,  -- Show in brand registry

  -- Lifecycle
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Discovered brands (from crawling brand.json files)
-- Similar to discovered_properties but for buy-side
CREATE TABLE discovered_brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Brand identification
  domain TEXT NOT NULL UNIQUE,  -- Domain where brand.json was found
  canonical_domain TEXT,  -- Resolved canonical domain (may differ from domain)
  house_domain TEXT,  -- House domain if this brand belongs to a portfolio

  -- Brand details from brand.json
  brand_name TEXT,  -- Primary brand name
  brand_names JSONB DEFAULT '[]',  -- Full names array
  keller_type TEXT,  -- master, sub-brand, endorsed, independent
  parent_brand TEXT,  -- Parent brand canonical domain if applicable

  -- Agent info (if brand has an agent)
  brand_agent_url TEXT,
  brand_agent_capabilities TEXT[],

  -- Brand manifest info
  has_brand_manifest BOOLEAN DEFAULT FALSE,
  brand_manifest JSONB,  -- Cached brand manifest

  -- Source tracking
  source_type TEXT DEFAULT 'brand_json',  -- brand_json, community, enriched

  -- Discovery metadata
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

-- Brand properties (maps properties to brands)
-- Enables lookups like "which brand owns jumpman23.com?"
CREATE TABLE brand_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Brand this property belongs to
  brand_canonical_domain TEXT NOT NULL,

  -- Property identification (matches AdCP property format)
  property_type TEXT NOT NULL,  -- website, mobile_app, ctv_app, etc.
  identifier TEXT NOT NULL,  -- Domain for websites, bundle ID for apps
  store TEXT,  -- apple, google, etc. for apps

  -- Property metadata
  region TEXT,  -- ISO country code or 'global'
  is_primary BOOLEAN DEFAULT FALSE,

  -- Discovery
  discovered_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique: one property can only belong to one brand
  UNIQUE(property_type, identifier, store)
);

-- Indexes for hosted_brands
CREATE INDEX idx_hosted_brands_org ON hosted_brands(workos_organization_id);
CREATE INDEX idx_hosted_brands_domain ON hosted_brands(brand_domain);
CREATE INDEX idx_hosted_brands_created_by ON hosted_brands(created_by_email);
CREATE INDEX idx_hosted_brands_public ON hosted_brands(is_public) WHERE is_public = TRUE;

-- Indexes for discovered_brands
CREATE INDEX idx_discovered_brands_domain ON discovered_brands(domain);
CREATE INDEX idx_discovered_brands_canonical ON discovered_brands(canonical_domain);
CREATE INDEX idx_discovered_brands_house ON discovered_brands(house_domain);
CREATE INDEX idx_discovered_brands_name ON discovered_brands(brand_name);
CREATE INDEX idx_discovered_brands_keller_type ON discovered_brands(keller_type);
CREATE INDEX idx_discovered_brands_source ON discovered_brands(source_type);
CREATE INDEX idx_discovered_brands_expires ON discovered_brands(expires_at) WHERE expires_at IS NOT NULL;

-- Indexes for brand_properties
CREATE INDEX idx_brand_properties_brand ON brand_properties(brand_canonical_domain);
CREATE INDEX idx_brand_properties_identifier ON brand_properties(identifier);
CREATE INDEX idx_brand_properties_type ON brand_properties(property_type);

-- Trigger for updated_at on hosted_brands
CREATE TRIGGER update_hosted_brands_updated_at
  BEFORE UPDATE ON hosted_brands
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
