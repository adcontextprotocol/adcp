-- Migration: SI Availability Checks
-- Tracks anonymous pre-flight availability checks for SI protocol

-- Create SI availability checks table
CREATE TABLE IF NOT EXISTS si_availability_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The availability token (used for correlation)
    token VARCHAR NOT NULL UNIQUE,

    -- Which brand was checked
    member_profile_id UUID REFERENCES member_profiles(id),

    -- What was checked
    offer_id VARCHAR,
    product_id VARCHAR,

    -- Anonymous context (no PII)
    context TEXT,

    -- Result
    available BOOLEAN DEFAULT true,

    -- Timestamps
    checked_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    -- Link to session if this check was used
    used_in_session_id VARCHAR REFERENCES si_sessions(session_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_si_availability_checks_token ON si_availability_checks(token);
CREATE INDEX IF NOT EXISTS idx_si_availability_checks_member ON si_availability_checks(member_profile_id);
CREATE INDEX IF NOT EXISTS idx_si_availability_checks_expires ON si_availability_checks(expires_at);
CREATE INDEX IF NOT EXISTS idx_si_availability_checks_offer ON si_availability_checks(offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_si_availability_checks_product ON si_availability_checks(product_id) WHERE product_id IS NOT NULL;

-- Add comment
COMMENT ON TABLE si_availability_checks IS 'Tracks anonymous pre-flight availability checks for SI protocol. No user data stored - only offer/product verification.';
