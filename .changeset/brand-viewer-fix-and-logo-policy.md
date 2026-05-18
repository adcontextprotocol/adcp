---
---

fix(brand-viewer): restore community brand serving + restrict logo writes to verified owners

Two regressions surfaced together when the Fandom / scope3.com brand pages stopped rendering correctly and Harvin reported he could instantly swap any brand's logo. Both fixes ship in one PR because they share the same data path.

**Issue A — `/brands/{domain}/brand.json` started 404'ing for hand-curated brands.**

PR #3529 (2026-05-14) added a `source_type` gate so raw Brandfetch-enriched rows would no longer be served as if they were brand-attested. Correct intent — but the gate also rejected community brands whose manifest didn't wrap itself in `house+brands` / `agents` / `brand_agent` / `authoritative_location`, and `editDiscoveredBrand` never promoted the row's `source_type` when a human curated it. Net effect: every Brandfetch-seeded row that AAO members had curated (scope3.com, fandom.com, …) silently started 404'ing.

Fix:
- Drop the structural-shape requirement on `/brands/{domain}/brand.json` — the `source_type` gate is sufficient to keep raw Brandfetch data out, and the AAO edit UI writes flat manifests that the previous shape check rejected.
- `editDiscoveredBrand` promotes `source_type='enriched' → 'community'` on first human edit. A Brandfetch-seeded row that's been hand-curated is community-attested.
- One-shot migration `483_promote_enriched_brands_with_revisions.sql`: promote any `enriched` row that has rows in `brand_revisions` (= someone already curated it). Brandfetch-only rows with no human touch stay enriched and stay 404, which is correct.

**Issue B — anyone could swap any brand's logo (Harvin / Brian's call).**

Per #3393 community uploads auto-approved instantly. Brian's direction: if a brand has a verified owner, only that org can change the logo. Implemented matrix:

| Brand state | Who can upload | Auto-approve? |
|---|---|---|
| Verified owner exists | Only members of the owning org (others → 403 `verified_owner_required`) | Yes — owner attestation |
| No verified owner | Any AAO member (today's rule) | **No** — queues as `review_status='pending'` for moderator review |
| `source_type='brand_json'` | n/a (managed self-hosted) | n/a |

Walks back the community half of #3393's auto-approval. Moderation queue throughput is an ops tuning problem, not an architectural one.

**Tests**

24 unit tests across 3 new files: gate behavior on the brand.json endpoint, `editDiscoveredBrand` source_type promotion (enriched promotes, community doesn't churn, brand_json stays rejected), and the full upload auth matrix.

**KYC follow-up**

Brian's broader point — "you registered as fandom.com but haven't verified it, please do that either here or in AAO" — cross-cuts onboarding and brand-claim suggestion at signup. Tracked separately, not in this PR.
