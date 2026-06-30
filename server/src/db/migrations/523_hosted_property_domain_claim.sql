-- Migration: 523_hosted_property_domain_claim.sql
-- Purpose: Bind-on-verify domain claims for AAO-hosted properties (RFC #5749 gap #1).
--
-- The community write surface stays open (anyone can stage a non-authoritative,
-- private community row). Authority over a domain is established by binding an
-- owner ON successful origin verification, not by gating the write.
--
-- An account "claims" a domain and receives a claim-specific authoritative_location
-- URL carrying a token (…/adagents.json?adcp_claim=<token>). The account places that
-- single pointer at their own origin; verify-origin reads the token and binds
-- workos_organization_id to the claim's org. The token is the per-account artifact
-- that proves *which* account owns the domain — a plain domain-keyed pointer proves
-- only that the origin endorses AAO hosting, not who the owner is.
--
--   - claim_token: pending claim token. The owner pastes a pointer carrying it; the
--     verifier matches it to bind. NULL once consumed/absent.
--   - claimant_org_id: the org that requested the pending claim. Becomes
--     workos_organization_id on successful verification. NULL if no pending claim.
--
-- A row is "locked" when workos_organization_id IS NOT NULL AND origin_verified_at
-- IS NOT NULL. The application layer refuses to change the owner of a locked row and
-- refuses to issue a claim for a domain locked to a different org.

ALTER TABLE hosted_properties
  ADD COLUMN IF NOT EXISTS claim_token TEXT NULL,
  ADD COLUMN IF NOT EXISTS claimant_org_id VARCHAR(255) NULL
    REFERENCES organizations(workos_organization_id) ON DELETE SET NULL;

-- Look up a pending claim by token at verify time.
CREATE INDEX IF NOT EXISTS idx_hosted_properties_claim_token
  ON hosted_properties(claim_token)
  WHERE claim_token IS NOT NULL;
