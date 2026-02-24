-- Migration: Referral codes system
-- Members can create referral codes to give to prospects.
-- Optionally tied to a target company name, which becomes a stakeholder link on conversion.

CREATE TABLE IF NOT EXISTS referral_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  referrer_org_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  referrer_user_id TEXT NOT NULL,
  referrer_user_name TEXT NOT NULL,
  referrer_user_email TEXT,
  target_company_name TEXT,
  discount_percent INTEGER CHECK (discount_percent >= 1 AND discount_percent <= 100),
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- referrals: Tracks each use of a referral code
CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referral_code_id INTEGER NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  referrer_org_id TEXT NOT NULL,
  referrer_user_id TEXT NOT NULL,
  target_company_name TEXT,
  referred_org_id TEXT REFERENCES organizations(workos_organization_id) ON DELETE SET NULL,
  referred_user_id TEXT,
  referred_company_name TEXT,
  referred_contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted')),
  converted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_referrer_org ON referral_codes(referrer_org_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_status ON referral_codes(status);
CREATE INDEX IF NOT EXISTS idx_referrals_referral_code_id ON referrals(referral_code_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_org ON referrals(referred_org_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_org ON referrals(referrer_org_id);

-- View used by referral dashboard endpoints
CREATE OR REPLACE VIEW referral_dashboard AS
SELECT
  rc.id AS code_id,
  rc.code,
  rc.referrer_org_id,
  rc.referrer_user_id,
  rc.target_company_name,
  rc.discount_percent,
  rc.max_uses,
  rc.used_count,
  rc.status AS code_status,
  rc.expires_at,
  rc.created_at AS code_created_at,
  referrer_org.name AS referrer_org_name,
  r.id AS referral_id,
  r.referred_org_id,
  r.referred_user_id,
  r.referred_company_name,
  r.referred_contact_email,
  r.status AS referral_status,
  r.converted_at,
  r.created_at AS referred_at,
  referred_org.name AS referred_org_name,
  referred_org.membership_tier AS referred_org_membership_tier
FROM referral_codes rc
LEFT JOIN referrals r ON r.referral_code_id = rc.id
LEFT JOIN organizations referrer_org ON referrer_org.workos_organization_id = rc.referrer_org_id
LEFT JOIN organizations referred_org ON referred_org.workos_organization_id = r.referred_org_id;

COMMENT ON TABLE referral_codes IS 'Referral codes created by members to recruit prospects. Optionally named for a target company.';
COMMENT ON TABLE referrals IS 'Tracks each use of a referral code, linking referrer to the new org on conversion.';
COMMENT ON COLUMN referral_codes.target_company_name IS 'Optional: the company this code was created for (e.g. "Nike"). On conversion, referrer becomes stakeholder owner of that org.';
COMMENT ON COLUMN referral_codes.max_uses IS 'NULL means unlimited uses.';
