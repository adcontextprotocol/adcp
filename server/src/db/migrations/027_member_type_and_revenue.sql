-- Migration: Add company_type and revenue_tier to organizations
-- These fields capture information collected during company onboarding

-- company_type: The type of company (brand, publisher, agency, adtech)
-- revenue_tier: The company's annual revenue tier

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS company_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS revenue_tier VARCHAR(50);

-- Index for querying by company type
CREATE INDEX IF NOT EXISTS idx_organizations_company_type ON organizations(company_type);

-- Index for querying by revenue tier
CREATE INDEX IF NOT EXISTS idx_organizations_revenue_tier ON organizations(revenue_tier);

-- Add CHECK constraints for valid values
ALTER TABLE organizations
  ADD CONSTRAINT organizations_company_type_check
  CHECK (company_type IS NULL OR company_type IN ('brand', 'publisher', 'agency', 'adtech', 'other'));

ALTER TABLE organizations
  ADD CONSTRAINT organizations_revenue_tier_check
  CHECK (revenue_tier IS NULL OR revenue_tier IN ('under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'));
