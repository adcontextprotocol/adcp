-- Track how each organization membership came to exist.
--
-- Existing rows are NULL ('unknown'). New rows are tagged at creation by the
-- code path that triggered them: autoLinkByVerifiedDomain → 'verified_domain',
-- /members/by-email Path 1 → 'invited', Path 2 → 'admin_added',
-- POST /:orgId/invitations → 'invited', everything else (sync from WorkOS,
-- webhook for an externally-created membership) → 'webhook'.
--
-- Used by the new-member digest in the auto-provision notification feature so
-- org owners can see which auto-joined members showed up via verified-domain
-- vs. were explicitly invited.

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS provisioning_source VARCHAR(32);

COMMENT ON COLUMN organization_memberships.provisioning_source IS
  'How this membership was created: verified_domain, invited, admin_added, webhook, unknown';

CREATE INDEX IF NOT EXISTS idx_organization_memberships_provisioning_source
  ON organization_memberships(workos_organization_id, provisioning_source, created_at DESC)
  WHERE provisioning_source IS NOT NULL;

-- Mirror on the invitation_seat_types staging table so the webhook handler can
-- read the source set by the originating endpoint and apply it to the local
-- cache row when the membership.created event arrives.
ALTER TABLE invitation_seat_types
  ADD COLUMN IF NOT EXISTS source VARCHAR(32);

COMMENT ON COLUMN invitation_seat_types.source IS
  'Provisioning source to apply to the membership when this staging row is consumed';
