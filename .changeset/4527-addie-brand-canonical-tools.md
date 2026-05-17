---
---

Addie: four new MCP tools for authoring distributed brand.json documents per the brand-protocol 3.1 spec (#4527).
- `publish_brand_canonical_document` generates a variant-5 Brand Canonical Document and validates it against the brand.json schema before returning it for the operator to host.
- `add_to_brand_refs` appends a `portfolio_entry` pointer to a House Portfolio's `brand_refs[]` and enforces the cross-array uniqueness invariants from the Conformance section.
- `check_mutual_assertion` fetches the leaf's canonical document and its claimed house's portfolio (following House Redirects on the house side, capped at 3 hops) and classifies the relationship into `mutual` / `leaf_only` / `house_only` / `standalone` / `unverifiable`.
- `notify_pending_verification` sends the SHOULD-level notification to the house's `contact.email` on `leaf_only` edges, rate-limited per `{leaf, house}` pair at one notification per 24 hours via the new `brand_assertion_notifications` table. Gated by `BRAND_ASSERTION_EMAIL_ENABLED` (defaults to log-only).
