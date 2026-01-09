-- Migration: 151_public_content_collections.sql
-- Add support for site-wide content collections that anyone can submit to
-- Examples: Perspectives, Learn Agentic (Training & Education)

-- =============================================================================
-- 1. Add accepts_public_submissions flag to working_groups
-- =============================================================================

ALTER TABLE working_groups
  ADD COLUMN IF NOT EXISTS accepts_public_submissions BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN working_groups.accepts_public_submissions IS
  'If true, any authenticated user can submit content to this group (requires lead approval)';

-- =============================================================================
-- 2. Create Editorial working group for site-wide Perspectives
-- =============================================================================

INSERT INTO working_groups (slug, name, description, accepts_public_submissions)
VALUES (
  'editorial',
  'Editorial',
  'Site-wide perspectives and thought leadership content. Anyone can submit, editorial team approves.',
  TRUE
)
ON CONFLICT (slug) DO UPDATE SET
  accepts_public_submissions = TRUE,
  description = EXCLUDED.description;

-- =============================================================================
-- 3. Mark Training & Education as accepting public submissions
-- =============================================================================

UPDATE working_groups
SET accepts_public_submissions = TRUE,
    description = COALESCE(description, '') || ' Anyone can submit educational content for review.'
WHERE slug = 'training-education-wg';

-- =============================================================================
-- 4. Create index for efficient lookup of public collections
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_working_groups_public_submissions
  ON working_groups(accepts_public_submissions)
  WHERE accepts_public_submissions = TRUE;

-- =============================================================================
-- 5. Migrate existing personal perspectives to Editorial
-- =============================================================================

-- Move any existing perspectives without a working_group_id to Editorial
UPDATE perspectives
SET working_group_id = (SELECT id FROM working_groups WHERE slug = 'editorial')
WHERE working_group_id IS NULL;

-- =============================================================================
-- Done
-- =============================================================================
