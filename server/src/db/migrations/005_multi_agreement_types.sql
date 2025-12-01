-- Migration: Support multiple agreement types (ToS, Privacy, Membership)
-- Allows tracking acceptance of different legal documents separately

-- Add agreement type support to existing agreements table
ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS agreement_type VARCHAR(50) NOT NULL DEFAULT 'membership'
    CHECK (agreement_type IN ('terms_of_service', 'privacy_policy', 'membership'));

-- Update unique constraint to include type (allows same version number for different types)
ALTER TABLE agreements DROP CONSTRAINT IF EXISTS agreements_version_key;
ALTER TABLE agreements
  ADD CONSTRAINT unique_type_version UNIQUE(agreement_type, version);

-- Create user agreement acceptances table
-- Tracks individual user acceptances of ToS/Privacy (all users) and Membership (paid orgs)
CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- User who accepted
  workos_user_id VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,

  -- Agreement details
  agreement_type VARCHAR(50) NOT NULL
    CHECK (agreement_type IN ('terms_of_service', 'privacy_policy', 'membership')),
  agreement_version VARCHAR(50) NOT NULL,

  -- Acceptance metadata (audit trail)
  accepted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address VARCHAR(50),
  user_agent TEXT,

  -- Reference to organization if membership agreement
  workos_organization_id VARCHAR(255),

  -- Prevent duplicate acceptances
  CONSTRAINT unique_user_agreement
    UNIQUE(workos_user_id, agreement_type, agreement_version)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_agreements_user ON user_agreement_acceptances(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_user_agreements_org ON user_agreement_acceptances(workos_organization_id);

-- Seed initial agreements with placeholder text
INSERT INTO agreements (version, agreement_type, text, effective_date)
VALUES
  (
    '1.0',
    'terms_of_service',
    E'# Terms of Service\n\nVersion 1.0 - Effective Date: ' || CURRENT_DATE || E'\n\n[Placeholder: Terms of Service content will be added here]\n\nBy using the AdCP Registry, you agree to these terms.',
    CURRENT_DATE
  ),
  (
    '1.0',
    'privacy_policy',
    E'# Privacy Policy\n\nVersion 1.0 - Effective Date: ' || CURRENT_DATE || E'\n\n[Placeholder: Privacy Policy content will be added here]\n\nThis policy describes how we collect, use, and protect your data.',
    CURRENT_DATE
  ),
  (
    '1.0',
    'membership',
    E'# AgenticAdvertising.org Membership Agreement\n\nVersion 1.0 - Effective Date: ' || CURRENT_DATE || E'\n\n[Placeholder: Membership Agreement content will be added here]\n\nBy becoming a paid member, you agree to these membership terms.',
    CURRENT_DATE
  )
ON CONFLICT (agreement_type, version) DO NOTHING;
