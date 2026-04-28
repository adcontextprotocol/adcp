-- Cohort gate for hierarchical auto-provisioning.
--
-- When an admin flips auto_provision_brand_hierarchy_children from false→true,
-- record the moment. autoLinkByVerifiedDomain checks user.created_at against
-- this timestamp so existing users are NOT retroactively grafted into the
-- parent org — only NEW joiners flow up via the inheritance edge.
--
-- Without this gate, flipping the flag silently captures the entire backlog
-- of child-domain users on their next request. Grandfather semantics is
-- safer; matches the SaaS norm. Code-review fixup on PR #3378.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_provision_hierarchy_enabled_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.auto_provision_hierarchy_enabled_at IS
  'Set when auto_provision_brand_hierarchy_children transitions from false to true. autoLinkByVerifiedDomain only auto-joins users whose users.created_at >= this timestamp, so flipping the flag captures only new joiners (not the existing backlog).';

-- Trigger: capture the timestamp when the flag transitions false→true.
-- Reset to NULL on the reverse transition so a future re-enable creates
-- a fresh cohort.
CREATE OR REPLACE FUNCTION track_auto_provision_hierarchy_enabled_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.auto_provision_brand_hierarchy_children IS DISTINCT FROM NEW.auto_provision_brand_hierarchy_children THEN
    IF NEW.auto_provision_brand_hierarchy_children = true THEN
      NEW.auto_provision_hierarchy_enabled_at := COALESCE(NEW.auto_provision_hierarchy_enabled_at, NOW());
    ELSE
      NEW.auto_provision_hierarchy_enabled_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organizations_auto_provision_hierarchy_enabled_at ON organizations;
CREATE TRIGGER organizations_auto_provision_hierarchy_enabled_at
BEFORE UPDATE ON organizations
FOR EACH ROW
EXECUTE FUNCTION track_auto_provision_hierarchy_enabled_at();
