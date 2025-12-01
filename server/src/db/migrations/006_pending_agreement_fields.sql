-- Add pending agreement fields to organizations table
-- These are used to store agreement info when checkbox is checked
-- Actual acceptance is recorded when payment succeeds

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_agreement_version VARCHAR(50);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_agreement_accepted_at TIMESTAMP WITH TIME ZONE;

-- Add comment
COMMENT ON COLUMN organizations.pending_agreement_version IS 'Pending agreement version (from checkbox), actual acceptance recorded on payment';
COMMENT ON COLUMN organizations.pending_agreement_accepted_at IS 'When user checked agreement checkbox (actual acceptance on payment)';
