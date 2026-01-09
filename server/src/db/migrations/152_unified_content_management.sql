-- Migration: 150_unified_content_management.sql
-- Unified content management system with co-authoring, ownership, and proposal workflow
-- See specs/unified-content-management.md for full spec

-- =============================================================================
-- 1. Create content_authors table for co-authoring support
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_authors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perspective_id UUID NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,  -- WorkOS user ID
  display_name VARCHAR(255) NOT NULL,
  display_title VARCHAR(255),
  display_order INTEGER DEFAULT 0,  -- For author ordering (0 = primary)
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(perspective_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_content_authors_perspective ON content_authors(perspective_id);
CREATE INDEX IF NOT EXISTS idx_content_authors_user ON content_authors(user_id);

COMMENT ON TABLE content_authors IS 'Authors of content items - supports multiple co-authors per perspective';
COMMENT ON COLUMN content_authors.display_order IS 'Lower numbers appear first; 0 = primary author';

-- =============================================================================
-- 2. Add proposer tracking and review workflow columns to perspectives
-- =============================================================================

ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS proposer_user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_perspectives_proposer ON perspectives(proposer_user_id);
CREATE INDEX IF NOT EXISTS idx_perspectives_proposed_at ON perspectives(proposed_at);

COMMENT ON COLUMN perspectives.proposer_user_id IS 'User who originally proposed/submitted this content';
COMMENT ON COLUMN perspectives.proposed_at IS 'When content was submitted for review';
COMMENT ON COLUMN perspectives.reviewed_by_user_id IS 'User who approved/rejected this content';
COMMENT ON COLUMN perspectives.reviewed_at IS 'When content was reviewed';
COMMENT ON COLUMN perspectives.rejection_reason IS 'Reason given when content was rejected';

-- =============================================================================
-- 3. Update status constraint to include new states
-- =============================================================================

-- Drop existing constraint and add new one with pending_review and rejected
ALTER TABLE perspectives
  DROP CONSTRAINT IF EXISTS perspectives_status_check;

ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_status_check
    CHECK (status IN ('draft', 'pending_review', 'published', 'archived', 'rejected'));

-- =============================================================================
-- 4. Backfill existing data
-- =============================================================================

-- Set proposer_user_id from author_user_id where not already set
UPDATE perspectives
SET proposer_user_id = author_user_id
WHERE proposer_user_id IS NULL AND author_user_id IS NOT NULL;

-- Create content_authors records from existing author data
-- This preserves backward compatibility while enabling co-authoring
INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT
  p.id,
  p.author_user_id,
  COALESCE(p.author_name, 'Unknown'),
  p.author_title,
  0  -- Primary author
FROM perspectives p
WHERE p.author_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM content_authors ca
    WHERE ca.perspective_id = p.id AND ca.user_id = p.author_user_id
  );

-- =============================================================================
-- 5. Create helper view for content with authors
-- =============================================================================

CREATE OR REPLACE VIEW content_with_authors AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'user_id', ca.user_id,
        'display_name', ca.display_name,
        'display_title', ca.display_title,
        'display_order', ca.display_order
      ) ORDER BY ca.display_order
    )
    FROM content_authors ca
    WHERE ca.perspective_id = p.id),
    '[]'::json
  ) AS authors_json
FROM perspectives p;

COMMENT ON VIEW content_with_authors IS 'Perspectives with aggregated authors as JSON';

-- =============================================================================
-- 6. Create function to check if user is committee lead
-- =============================================================================

CREATE OR REPLACE FUNCTION is_committee_lead(committee_id UUID, user_id VARCHAR)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM working_group_leaders wgl
    WHERE wgl.working_group_id = committee_id
      AND wgl.user_id = is_committee_lead.user_id
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION is_committee_lead IS 'Check if a user is a leader of a given committee/working group';

-- =============================================================================
-- 7. Create function to check content ownership
-- =============================================================================

CREATE OR REPLACE FUNCTION is_content_owner(perspective_id UUID, user_id VARCHAR)
RETURNS BOOLEAN AS $$
DECLARE
  v_working_group_id UUID;
  v_proposer_user_id VARCHAR;
BEGIN
  -- Get the perspective details
  SELECT p.working_group_id, p.proposer_user_id
  INTO v_working_group_id, v_proposer_user_id
  FROM perspectives p
  WHERE p.id = perspective_id;

  -- Not found
  IF v_working_group_id IS NULL AND v_proposer_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Committee content: check if user is a lead
  IF v_working_group_id IS NOT NULL THEN
    RETURN is_committee_lead(v_working_group_id, user_id);
  END IF;

  -- Personal content: check if user is the proposer or an author
  RETURN v_proposer_user_id = user_id OR EXISTS (
    SELECT 1 FROM content_authors ca
    WHERE ca.perspective_id = is_content_owner.perspective_id
      AND ca.user_id = is_content_owner.user_id
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION is_content_owner IS 'Check if a user owns/controls a piece of content';

-- =============================================================================
-- Done
-- =============================================================================
