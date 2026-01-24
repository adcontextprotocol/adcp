-- Add membership_tier column to capture the user's selected membership tier during signup
-- This helps with billing and distinguishes:
-- - individual_professional ($250/year) vs individual_academic ($50/year for academics, students, non-profits)
-- - company_standard ($2.5K or $10K based on revenue) vs company_icl ($50K Industry Council Leader)

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS membership_tier TEXT;

-- Add comment explaining the valid values
COMMENT ON COLUMN organizations.membership_tier IS 'Membership tier selected during signup: individual_professional, individual_academic, company_standard, company_icl';
