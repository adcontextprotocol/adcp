-- Brand-hierarchy auto-provisioning: opt-in.
--
-- autoLinkByVerifiedDomain auto-adds users whose email domain matches a
-- verified organization_domains row (gated by auto_provision_verified_domain,
-- migration 434). After PR 3378 it can ALSO auto-add via brands.house_domain
-- ascent — a child-brand employee inheriting into a paying parent org.
--
-- Hierarchical inheritance has a bigger blast radius than direct verified-
-- domain auto-provisioning:
--   - direct: WorkOS verified the user's domain via DNS — strong evidence
--     they belong to the org.
--   - hierarchical: an LLM classifier (or admin PATCH) decided the user's
--     domain is a child of the org's domain. Stale on M&A, attackable via
--     brand-registry data quality, and the joining user has no domain-level
--     confirmation that they belong here.
--
-- Two separate flags so an org can keep direct auto-provisioning enabled
-- (low risk, the default) while declining hierarchical inheritance (this
-- new flag, default OFF — opt-in). Opt-in matches the SaaS norm for fuzzy
-- joins (Slack/Notion/Linear all suggest, never silently grant).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_provision_brand_hierarchy_children BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organizations.auto_provision_brand_hierarchy_children IS
  'When true, users whose email domain is a child of this org''s verified domain via brands.house_domain ascent are auto-added as members. Default false — hierarchical inheritance is opt-in because brand-registry M&A data lags reality and the joining user has no domain-level confirmation.';
