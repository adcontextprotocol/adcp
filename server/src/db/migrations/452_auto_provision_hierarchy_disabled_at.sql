-- Preserve forensic history for the auto_provision_brand_hierarchy_children toggle.
--
-- Migration 450 added auto_provision_hierarchy_enabled_at as a cohort gate:
-- autoLinkByVerifiedDomain only auto-joins users created after this timestamp.
-- Before this migration, flipping the flag OFF cleared enabled_at to NULL,
-- erasing the "when was this last on?" record needed for incident response.
--
-- This migration adds disabled_at so both timestamps survive the on→off cycle.
-- The cohort gate continues to read enabled_at (unchanged). disabled_at is
-- forensic-only: it tells incident responders when the feature was last disabled.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_provision_hierarchy_disabled_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.auto_provision_hierarchy_disabled_at IS
  'Set when auto_provision_brand_hierarchy_children transitions from true to false. '
  'Forensic-only — does not affect the cohort gate. '
  'auto_provision_hierarchy_enabled_at remains authoritative for autoLinkByVerifiedDomain.';

-- Update trigger: on flip-on, set enabled_at (COALESCE preserves the original
-- timestamp on re-enable — intentional, so users who joined after the first
-- enable but before a re-enable are not retroactively excluded from the cohort
-- gate); on flip-off, set disabled_at and leave enabled_at intact (was: clear
-- enabled_at to NULL).
CREATE OR REPLACE FUNCTION track_auto_provision_hierarchy_enabled_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.auto_provision_brand_hierarchy_children IS DISTINCT FROM NEW.auto_provision_brand_hierarchy_children THEN
    IF NEW.auto_provision_brand_hierarchy_children = true THEN
      NEW.auto_provision_hierarchy_enabled_at := COALESCE(NEW.auto_provision_hierarchy_enabled_at, NOW());
    ELSE
      NEW.auto_provision_hierarchy_disabled_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-bind the trigger (matches migration 450 pattern; ensures idempotency
-- if the trigger is ever dropped and migrations are re-run).
DROP TRIGGER IF EXISTS organizations_auto_provision_hierarchy_enabled_at ON organizations;
CREATE TRIGGER organizations_auto_provision_hierarchy_enabled_at
BEFORE UPDATE ON organizations
FOR EACH ROW
EXECUTE FUNCTION track_auto_provision_hierarchy_enabled_at();
