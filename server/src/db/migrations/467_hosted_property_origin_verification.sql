-- Migration: 467_hosted_property_origin_verification.sql
-- Purpose: Track origin verification on AAO-hosted publisher properties.
--
-- An AAO-hosted publisher document carries authority only when the
-- publisher's own /.well-known/adagents.json points at us via the
-- spec's `authoritative_location` field. Until origin verification
-- happens, an AAO-hosted document represents publisher *intent*, not
-- origin attestation — and the corresponding agent_publisher_authorizations
-- rows carry source='aao_hosted' (less trusted than 'adagents_json').
--
-- This migration adds two timestamps to hosted_properties:
--   - origin_verified_at: when verification last succeeded. NULL if
--     never verified or last attempt failed.
--   - origin_last_checked_at: when verification was last attempted,
--     regardless of result. Lets the UI show "checked X minutes ago,
--     not yet verified" vs "checked, verified".
--
-- A successful verification triggers promotion of agent_publisher_authorizations
-- rows from source='aao_hosted' to source='adagents_json' for the
-- agents present in the manifest. The promotion runs in the application
-- layer (server/src/services/hosted-property-origin-verifier.ts) — this
-- migration only adds storage.

ALTER TABLE hosted_properties
  ADD COLUMN IF NOT EXISTS origin_verified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS origin_last_checked_at TIMESTAMPTZ NULL;

-- Partial index: only verified rows are interesting for "verified
-- publishers" queries. Saves index size on the larger unverified set.
CREATE INDEX IF NOT EXISTS idx_hosted_properties_origin_verified
  ON hosted_properties(origin_verified_at)
  WHERE origin_verified_at IS NOT NULL;
