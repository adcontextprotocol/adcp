-- Migration: Link referral codes to prospect organizations
-- Allows referral codes to be directly associated with a prospect org record,
-- enabling stakeholder auto-assignment and "My Accounts" visibility.

ALTER TABLE referral_codes
  ADD COLUMN IF NOT EXISTS target_org_id TEXT
    REFERENCES organizations(workos_organization_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_target_org
  ON referral_codes (target_org_id)
  WHERE target_org_id IS NOT NULL;

COMMENT ON COLUMN referral_codes.target_org_id IS
  'Optional FK to the prospect org this code was created for. When set, the creator is added as an "interested" stakeholder on that org.';
