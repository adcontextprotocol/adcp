-- Drop `member_profiles.primary_brand_domain` (Stage 2 of #4159).
--
-- The column was the brand-identity primary; Stage 0 backfilled the same
-- value into `organization_domains.is_primary=true` rows so the resolver
-- could read from one place. Stage 1 migrated every reader through
-- `getBrandPrimaryDomain` (resolver). Stage 2 (this migration + the code
-- changes that ship with it) removes the column entirely.
--
-- Spec: specs/domain-column-rationalization.md.
-- Issue: #4159.
-- Backfill that produced this state: scripts/backfill-primary-brand-domain.ts
--   and scripts/stage0-domain-cleanup.ts (deleted in this same PR).

ALTER TABLE member_profiles DROP COLUMN IF EXISTS primary_brand_domain;
