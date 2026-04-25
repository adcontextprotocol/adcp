-- Brand claim challenge — track which org issued a verification challenge
-- against a domain and when it expires.
--
-- The brands table already has `verification_token` from a stub that was never
-- wired (see #3176). This adds the bookkeeping needed to actually use it for a
-- file-placement claim flow:
--
--   1. Org calls POST /api/me/member-profile/brand-claim/issue.
--   2. Server generates a token, stamps verification_token_org_id (which org
--      asked for it), and sets verification_token_expires_at.
--   3. Org publishes the token at https://{domain}/.well-known/adcp-claim/{token}.
--   4. Server fetches that URL and matches the body against the stored token.
--      If it matches AND the issuing org matches the caller, the claim succeeds.
--
-- The org_id column lets a different verifying org reject a stale challenge
-- left behind by a previous claimant. Expiration prevents tokens from sitting
-- around indefinitely if a claim is abandoned.
ALTER TABLE brands
  ADD COLUMN verification_token_org_id TEXT,
  ADD COLUMN verification_token_expires_at TIMESTAMPTZ;

-- Partial index so the worker that GCs expired tokens (future) can find them
-- without scanning the whole table.
CREATE INDEX brands_verification_token_expiry_idx
  ON brands (verification_token_expires_at)
  WHERE verification_token IS NOT NULL;
