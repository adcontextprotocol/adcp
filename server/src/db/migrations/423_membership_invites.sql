-- Migration: membership invitations + per-org billing address
--
-- Admin sends an invitation (not a direct invoice) to a prospect contact.
-- The prospect accepts the invite link, signs the membership agreement,
-- confirms billing details, and only then is an invoice issued. This
-- prevents the "admin types wrong email, Stripe creates orphan customer,
-- payment goes through without linking to an org" class of bugs.
--
-- billing_address is stored on the org so follow-up invoices don't need
-- to re-collect it.

CREATE TABLE IF NOT EXISTS membership_invites (
  token TEXT PRIMARY KEY,
  workos_organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,
  lookup_key TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  referral_code TEXT,
  invited_by_user_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE,
  accepted_by_user_id TEXT,
  invoice_id TEXT,
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_by_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_membership_invites_org ON membership_invites(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_membership_invites_email ON membership_invites(contact_email);
CREATE INDEX IF NOT EXISTS idx_membership_invites_pending ON membership_invites(expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE membership_invites IS 'Admin-issued invitations for prospects to become paying members. Accepting the invite triggers agreement + billing collection, then issues the Stripe invoice.';
COMMENT ON COLUMN membership_invites.token IS 'Random 32-byte hex. Used in the invite URL (/invite/:token). Not guessable.';
COMMENT ON COLUMN membership_invites.lookup_key IS 'Stripe price lookup key identifying the tier (e.g. aao_membership_professional).';
COMMENT ON COLUMN membership_invites.invoice_id IS 'Stripe invoice ID, set when invoice is issued on acceptance.';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS billing_address JSONB;

COMMENT ON COLUMN organizations.billing_address IS 'Billing address confirmed by the org (line1, line2, city, state, postal_code, country). Pre-fills future invoices.';
