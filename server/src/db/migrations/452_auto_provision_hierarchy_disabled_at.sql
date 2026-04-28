-- Forensic preservation for auto_provision_brand_hierarchy_children toggle history.
--
-- Migration 450 set enabled_at when the flag flips on, but nulled it on flip-off,
-- destroying the forensic record of when the feature was last active.
-- This migration:
--   1. Adds auto_provision_hierarchy_disabled_at to record when the flag was last
--      flipped off.
--   2. Updates the trigger so flip-off sets disabled_at and PRESERVES enabled_at.
--      enabled_at remains the sole authoritative input for the cohort gate in
--      autoLinkByVerifiedDomain — this migration does not change that semantics.
--
-- Follow-up to PR #3430 security review. See issue #3466.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_provision_hierarchy_disabled_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.auto_provision_hierarchy_disabled_at IS
  'Set when auto_provision_brand_hierarchy_children transitions from true to false. Preserved alongside auto_provision_hierarchy_enabled_at for incident-response forensics. The cohort gate in autoLinkByVerifiedDomain reads only enabled_at as authoritative.';

-- Replace the trigger function body.
-- The trigger binding (organizations_auto_provision_hierarchy_enabled_at) is
-- unchanged — only the function logic is updated.
CREATE OR REPLACE FUNCTION track_auto_provision_hierarchy_enabled_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.auto_provision_brand_hierarchy_children IS DISTINCT FROM NEW.auto_provision_brand_hierarchy_children THEN
    IF NEW.auto_provision_brand_hierarchy_children = true THEN
      NEW.auto_provision_hierarchy_enabled_at := COALESCE(NEW.auto_provision_hierarchy_enabled_at, NOW());
    ELSE
      -- Record when the feature was last turned off; do NOT null enabled_at.
      -- A complete (enabled_at, disabled_at) pair lets incident response trace
      -- the full on/off cycle without losing the original opt-in timestamp.
      NEW.auto_provision_hierarchy_disabled_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
