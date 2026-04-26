---
---

Integration coverage for the orphan-adoption flow shipped in #3168. Closes the test gap code-reviewer flagged on that PR.

`server/tests/integration/brand-orphan-adoption.test.ts` exercises the end-to-end transaction against a real Postgres:

- `deleteHostedBrand` sets `manifest_orphaned=true`, stashes `prior_owner_org_id`, clears ownership, marks `is_public=false`, and **preserves** the manifest.
- `getDiscoveredBrandByDomain` still returns the row so callers can branch on the orphan flag.
- `updateBrandIdentity` throws `BrandIdentityError` with `code='orphan_manifest_decision_required'` and prior-owner meta when `adoptPriorManifest` is undefined for an orphaned brand.
- `adoptPriorManifest=false` clears the prior manifest and writes a fresh one with the new logo only; orphan flag clears, ownership transfers, `is_public=true`.
- `adoptPriorManifest=true` keeps the prior manifest and merges the new logo over it; prior colors persist.
- Cross-org write to a non-orphaned brand still throws `cross_org_ownership` even with `adopt_prior_manifest: true` (sanity check that the orphan path doesn't bypass the boundary).

`checkLogoUrlIsImage` is mocked at module-graph load so the test doesn't make outbound HEAD requests against `.example.com` URLs.
