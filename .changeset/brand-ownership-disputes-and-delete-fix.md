---
---

Three follow-ons to #3152 / #3159's transfer-tool work:

- **Cross-org write conflicts route through escalations.** When `updateBrandIdentity` rejects a write because the domain is owned by another org, both the web `PUT /api/me/member-profile/brand-identity` route and the `update_company_logo` member tool now file a `category: sensitive_topic` escalation. The framing is neutral — the dispute might be an acquisition, naming overlap, or backfill, not necessarily a squat — and admins resolve via the existing `transfer_brand_ownership` tool (#3159). Web returns 409 + escalation_id; chat returns a ticket-id message. If escalation creation itself fails, the user-facing message switches to a "please email support" line so we don't promise follow-up that won't happen.

- **Relinquished manifests are flagged for adoption, not nuked.** `deleteHostedBrand` previously cleared ownership but kept the prior org's `brand_manifest`, leaking the visual identity to any new claimant. Migration `430_brand_orphan_manifest.sql` adds `manifest_orphaned` and `prior_owner_org_id` columns; relinquish now sets the orphan flag (paired with `is_public=false`) and stashes the prior owner. Public reads filter orphaned brands. The new claimant can pass `adopt_prior_manifest: true` to keep the prior identity (acquisition / handoff case) or omit it to start fresh (default — protects against silent identity inheritance). Either way the orphan flag clears at claim time.

- **`BrandIdentityError` discriminator.** Adds a `code` + per-code `meta` (typed via `BrandIdentityErrorMetaByCode`) plus an `isCrossOrgOwnership()` type guard. Catch sites narrow on the guard so `err.meta.brandDomain` is typed as string instead of unknown — typos at compile time, not runtime.

Closes most of #3152. Auto-resolve via verified domain ownership (the "publish brand.json with our pointer to take it over" path) is filed separately as #3176 — it needs a real DNS-TXT or file-placement challenge rather than the current pointer-only check, which isn't strong enough to gate a provenance change against a sitting incumbent.
