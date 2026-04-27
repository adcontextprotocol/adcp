-- Track the last time the auto-provision new-member digest was sent for an
-- organization. The scheduled job uses this to find members auto-joined since
-- the previous digest (no per-member tracking, just a watermark per org).
--
-- NULL means we've never sent — the first run after this migration deploys
-- will look back at the full window of `verified_domain` provisioning_source
-- members and include all of them in that org's first digest.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS last_auto_provision_digest_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.last_auto_provision_digest_sent_at IS
  'Watermark for the auto-provision new-member digest. Updated when the digest is successfully delivered. NULL = never sent.';
