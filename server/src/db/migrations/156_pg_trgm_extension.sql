-- Enable pg_trgm extension for trigram similarity matching
-- Used for finding similar organization names with typo tolerance

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create index on organizations.name for faster similarity searches
CREATE INDEX IF NOT EXISTS idx_organizations_name_trgm
ON organizations USING gin (name gin_trgm_ops);
