-- Adds needs_revisions status and revision_notes column to perspectives.
-- Enables the editorial revision workflow: committee leads can send articles
-- back for revision (distinct from permanent rejection), and authors can
-- resubmit after addressing the feedback.

-- Widen CHECK constraint to include the new status
ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_status_check;
ALTER TABLE perspectives ADD CONSTRAINT perspectives_status_check
  CHECK (status IN ('draft', 'pending_review', 'published', 'archived', 'rejected', 'needs_revisions'));

-- Separate column for revision notes (keeps rejection_reason for terminal rejection only)
ALTER TABLE perspectives ADD COLUMN IF NOT EXISTS revision_notes TEXT;
ALTER TABLE perspectives ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;
