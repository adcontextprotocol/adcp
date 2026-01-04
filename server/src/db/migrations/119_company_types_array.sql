-- Migration: Convert company_type from single value to array and add new types
-- This allows organizations to have multiple types (e.g., Microsoft is both brand and ai)

-- Step 1: Add new column for array of company types
ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS company_types TEXT[];

-- Step 2: Migrate existing data from company_type to company_types array
UPDATE organizations
SET company_types = ARRAY[company_type]
WHERE company_type IS NOT NULL AND company_types IS NULL;

-- Step 3: Create index for array queries (GIN index for efficient containment checks)
CREATE INDEX IF NOT EXISTS idx_organizations_company_types
ON organizations USING GIN (company_types);

-- Step 4: Add comment documenting valid values
COMMENT ON COLUMN organizations.company_types IS 'Array of company types. Valid values: adtech, agency, brand, publisher, data, ai, other';

-- Note: We keep the old company_type column for backwards compatibility during transition.
-- It can be removed in a future migration after all code is updated.
