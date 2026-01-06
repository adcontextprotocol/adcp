-- Migration: Update company_type CHECK constraint to include 'data' and 'ai' types
-- These types were added to the frontend but the database constraint was not updated

-- Drop the old constraint (using IF EXISTS for idempotency)
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_company_type_check;

-- Add updated constraint with all valid company types
ALTER TABLE organizations
  ADD CONSTRAINT organizations_company_type_check
  CHECK (company_type IS NULL OR company_type IN ('adtech', 'agency', 'brand', 'data', 'ai', 'publisher', 'other'));
