-- Migration: 058_company_enrichment.sql
-- Add company enrichment data from Lusha or similar services

-- Add enrichment columns to organizations table
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_data JSONB;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_source VARCHAR(50);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_at TIMESTAMP WITH TIME ZONE;

-- Specific columns for common enrichment fields (for easier querying)
-- Prefixed with enrichment_ to clarify they come from external services
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_revenue BIGINT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_revenue_range VARCHAR(50);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_employee_count INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_employee_count_range VARCHAR(50);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_industry VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_sub_industry VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_founded_year INTEGER;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_country VARCHAR(100);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_city VARCHAR(100);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_linkedin_url VARCHAR(500);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_description TEXT;

-- Index for filtering by enrichment status
CREATE INDEX IF NOT EXISTS idx_organizations_enrichment ON organizations(enrichment_source, enrichment_at);

-- Index for filtering by revenue/size
CREATE INDEX IF NOT EXISTS idx_organizations_enrichment_revenue ON organizations(enrichment_revenue) WHERE enrichment_revenue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_enrichment_employees ON organizations(enrichment_employee_count) WHERE enrichment_employee_count IS NOT NULL;

-- Comments
COMMENT ON COLUMN organizations.enrichment_data IS 'Full JSON response from enrichment service';
COMMENT ON COLUMN organizations.enrichment_source IS 'Source of enrichment: lusha, clearbit, manual, etc.';
COMMENT ON COLUMN organizations.enrichment_at IS 'When enrichment data was last fetched';
COMMENT ON COLUMN organizations.enrichment_revenue IS 'Estimated annual revenue in USD (from enrichment)';
COMMENT ON COLUMN organizations.enrichment_revenue_range IS 'Human-readable revenue range (from enrichment)';
COMMENT ON COLUMN organizations.enrichment_employee_count IS 'Estimated employee count (from enrichment)';
COMMENT ON COLUMN organizations.enrichment_employee_count_range IS 'Human-readable employee range (from enrichment)';
COMMENT ON COLUMN organizations.enrichment_industry IS 'Primary industry classification (from enrichment)';
COMMENT ON COLUMN organizations.enrichment_sub_industry IS 'Sub-industry or specialization (from enrichment)';
