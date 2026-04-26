-- Brand registry orphan-manifest flag (#3152 follow-up)
--
-- When an org relinquishes a hosted brand via DELETE /api/brands/hosted/:domain,
-- we previously cleared workos_organization_id but kept brand_manifest. A new
-- claimant inherited the prior org's logos/colors/agents silently — a spoofing
-- vector. The simple fix was to clear brand_manifest on relinquish, but that
-- nukes legitimate-handoff cases (acquisitions, org renames) where the new
-- owner DOES want the prior identity as a starting point.
--
-- This migration adds two columns so we can mark a manifest as orphaned
-- without destroying it:
--
--   manifest_orphaned   — true when the prior org relinquished but the manifest
--                         is preserved for adoption. Public surfaces filter
--                         orphaned brands (paired with is_public=false).
--   prior_owner_org_id  — the workos_organization_id of the org that
--                         relinquished. Surfaces in admin UI / adoption flow
--                         so a new claimant knows whose identity they're
--                         adopting.
--
-- On the next legitimate claim through updateBrandIdentity, the new owner can
-- pass adoptPriorManifest=true to keep the prior manifest (merging in their
-- own logo/color updates), or omit it to start fresh. Either way, the orphan
-- flag is cleared at claim time.

ALTER TABLE brands
  ADD COLUMN manifest_orphaned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN prior_owner_org_id TEXT;

-- Index lets the (eventual) admin UI / adoption tools find brands that have
-- a relinquished manifest waiting to be adopted, without scanning the whole
-- table. Partial because the vast majority of brands are not orphaned.
CREATE INDEX brands_manifest_orphaned_idx
  ON brands (prior_owner_org_id)
  WHERE manifest_orphaned = TRUE;
