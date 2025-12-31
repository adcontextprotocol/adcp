-- Migration: 059_rename_enrichment_columns.sql
-- Rename enrichment columns to have enrichment_ prefix for clarity
-- These columns come from external enrichment services (Lusha, etc.)

-- Rename columns (only if old names exist)
DO $$
BEGIN
    -- estimated_revenue -> enrichment_revenue
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'estimated_revenue') THEN
        ALTER TABLE organizations RENAME COLUMN estimated_revenue TO enrichment_revenue;
    END IF;

    -- estimated_revenue_range -> enrichment_revenue_range
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'estimated_revenue_range') THEN
        ALTER TABLE organizations RENAME COLUMN estimated_revenue_range TO enrichment_revenue_range;
    END IF;

    -- employee_count -> enrichment_employee_count
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'employee_count') THEN
        ALTER TABLE organizations RENAME COLUMN employee_count TO enrichment_employee_count;
    END IF;

    -- employee_count_range -> enrichment_employee_count_range
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'employee_count_range') THEN
        ALTER TABLE organizations RENAME COLUMN employee_count_range TO enrichment_employee_count_range;
    END IF;

    -- industry -> enrichment_industry
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'industry') THEN
        ALTER TABLE organizations RENAME COLUMN industry TO enrichment_industry;
    END IF;

    -- sub_industry -> enrichment_sub_industry
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'sub_industry') THEN
        ALTER TABLE organizations RENAME COLUMN sub_industry TO enrichment_sub_industry;
    END IF;

    -- founded_year -> enrichment_founded_year
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'founded_year') THEN
        ALTER TABLE organizations RENAME COLUMN founded_year TO enrichment_founded_year;
    END IF;

    -- headquarters_country -> enrichment_country
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'headquarters_country') THEN
        ALTER TABLE organizations RENAME COLUMN headquarters_country TO enrichment_country;
    END IF;

    -- headquarters_city -> enrichment_city
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'headquarters_city') THEN
        ALTER TABLE organizations RENAME COLUMN headquarters_city TO enrichment_city;
    END IF;

    -- linkedin_url -> enrichment_linkedin_url
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'linkedin_url') THEN
        ALTER TABLE organizations RENAME COLUMN linkedin_url TO enrichment_linkedin_url;
    END IF;

    -- company_description -> enrichment_description
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'company_description') THEN
        ALTER TABLE organizations RENAME COLUMN company_description TO enrichment_description;
    END IF;
END $$;

-- Drop old indexes if they exist
DROP INDEX IF EXISTS idx_organizations_revenue;
DROP INDEX IF EXISTS idx_organizations_employees;

-- Create new indexes with correct names (if not already created by 054)
CREATE INDEX IF NOT EXISTS idx_organizations_enrichment_revenue ON organizations(enrichment_revenue) WHERE enrichment_revenue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_enrichment_employees ON organizations(enrichment_employee_count) WHERE enrichment_employee_count IS NOT NULL;
