---
---

feat(brand-viewer): first-class "Claim this brand" flow on `/brand/view/{domain}` (closes #4741)

Surfaces ownership state on the brand viewer page so visitors can tell at a glance whether a brand entry is community-hosted, verified-owned, or awaiting adoption — and gives every authenticated visitor a one-click path into the existing DNS-challenge claim flow.

**New endpoint**

- `GET /api/brands/:domain/ownership` (optional auth) — returns `{ status: community | verified | orphaned, owner: { name } | null, can_claim, can_manage, claim_url, manage_url, authenticated }`. Anonymous callers get status + display name; authenticated callers also get the management hint when their primary org owns the brand. The endpoint never grants edit authority — the actual claim still runs through `/api/me/member-profile/brand-claim/*` where DNS proves ownership.

**Viewer UX**

- Ownership badge in the hero ("Verified — owned by Acme Corp" / "Community" / "Awaiting adoption").
- "Claim this brand" CTA → `/brand/builder?domain={domain}` for authenticated visitors when the brand isn't verified-owned.
- "Manage brand" CTA → `/brand/builder?domain={domain}` for visitors whose primary org owns the brand.
- "Sign in to claim" for unauthenticated visitors on community/orphaned brands, with `return_to` back to the viewer.

The brand-builder page already accepts `?domain=` and pre-populates the claim flow, so no changes there.
