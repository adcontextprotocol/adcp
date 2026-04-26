-- Auto-provision verified-domain users into orgs.
--
-- When a user signs in with an email whose domain is verified on an
-- organization with an active subscription, autoLinkByVerifiedDomain creates
-- a WorkOS membership for them. This flag lets an org owner opt out — useful
-- for orgs that prefer explicit invites only (e.g. regulated industries).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_provision_verified_domain BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN organizations.auto_provision_verified_domain IS
  'When true (default), users whose email domain is verified on this org are auto-added as members on first authenticated request or user.created webhook. When false, only explicit invites grant membership.';
