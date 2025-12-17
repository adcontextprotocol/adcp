-- Migration: Add bylaws and ip_policy as agreement types
-- This allows storing and serving the organization's bylaws and IP policy alongside
-- other legal documents (membership agreement, terms of service, privacy policy)

-- Update the CHECK constraint on agreements table to include 'bylaws' and 'ip_policy'
ALTER TABLE agreements
  DROP CONSTRAINT IF EXISTS agreements_agreement_type_check;

ALTER TABLE agreements
  ADD CONSTRAINT agreements_agreement_type_check
  CHECK (agreement_type IN ('terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'));

-- Update the CHECK constraint on user_agreement_acceptances table to include 'bylaws' and 'ip_policy'
ALTER TABLE user_agreement_acceptances
  DROP CONSTRAINT IF EXISTS user_agreement_acceptances_agreement_type_check;

ALTER TABLE user_agreement_acceptances
  ADD CONSTRAINT user_agreement_acceptances_agreement_type_check
  CHECK (agreement_type IN ('terms_of_service', 'privacy_policy', 'membership', 'bylaws', 'ip_policy'));
