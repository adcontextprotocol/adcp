-- Migration: Referral acceptance flow
-- Adds an 'accepted' status so prospects can explicitly claim a referral code.
-- Once accepted, they have 30 days to subscribe with the attached discount.

-- Expand status values to include 'accepted' and 'expired'
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('pending', 'accepted', 'converted', 'expired'));

-- accepted_at: when the prospect accepted the invitation
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP WITH TIME ZONE;

-- expires_at: deadline to subscribe (accepted_at + 30 days); NULL for non-accepted referrals
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- Prevent an org from holding more than one active accepted referral at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_one_active_per_org
  ON referrals (referred_org_id)
  WHERE status = 'accepted' AND referred_org_id IS NOT NULL;

COMMENT ON COLUMN referrals.accepted_at IS 'When the prospect signed in and accepted the referral invitation.';
COMMENT ON COLUMN referrals.expires_at IS 'Deadline to subscribe with the discount (accepted_at + 30 days). NULL for invoice referrals.';
