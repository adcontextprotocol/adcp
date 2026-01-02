-- Migration: 084_committee_types.sql
-- Evolve working_groups into multi-type committees system

-- Add committee_type column with check constraint
ALTER TABLE working_groups
  ADD COLUMN IF NOT EXISTS committee_type VARCHAR(20) NOT NULL DEFAULT 'working_group'
    CHECK (committee_type IN ('working_group', 'council', 'chapter', 'governance'));

-- Add region column for chapters
ALTER TABLE working_groups
  ADD COLUMN IF NOT EXISTS region VARCHAR(255);

-- Create index on committee_type for efficient filtering
CREATE INDEX IF NOT EXISTS idx_working_groups_committee_type ON working_groups(committee_type);

-- Update existing governance groups to type='governance'
UPDATE working_groups
SET committee_type = 'governance'
WHERE slug IN ('board', 'aao-admin', 'advisory-council', 'technical-steering');

-- Add comments
COMMENT ON COLUMN working_groups.committee_type IS 'Type of committee: working_group, council, chapter, or governance';
COMMENT ON COLUMN working_groups.region IS 'Geographic region for chapter-type committees (e.g., NYC, London)';
