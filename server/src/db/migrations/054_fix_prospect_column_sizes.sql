-- Migration: Fix prospect column sizes
-- The original migration 031 specified VARCHAR(255) for contact fields,
-- but production may have smaller sizes due to a schema drift.
-- This migration ensures columns can hold the data they need.

-- Increase prospect_contact_name to handle longer names
ALTER TABLE organizations
  ALTER COLUMN prospect_contact_name TYPE VARCHAR(500);

-- Increase prospect_contact_title to handle longer titles
ALTER TABLE organizations
  ALTER COLUMN prospect_contact_title TYPE VARCHAR(500);

-- Ensure prospect_notes is TEXT (should already be, but just in case)
ALTER TABLE organizations
  ALTER COLUMN prospect_notes TYPE TEXT;

-- Add comment
COMMENT ON COLUMN organizations.prospect_contact_name IS 'Primary contact name(s) - can include multiple people';
