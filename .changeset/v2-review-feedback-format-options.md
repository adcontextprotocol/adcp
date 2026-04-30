---
"adcontextprotocol": minor
---

feat(creative): v2 review-feedback round — `format_options` array, canonical `status`, hosting paragraph, third-party creative-agent worked example

Addresses external review feedback on RFC #3305 / PR #3307 before the 3.1.0 beta cycle opens.

**Schema changes:**

- **`product.format` → `product.format_options: [ProductFormatDeclaration]` (array).** Restores v1 `format_ids` cardinality on the v2 path. The 90% case is a single-element array (one canonical narrowed for the product); multi-element arrays declare that the product accepts any of the listed format options (e.g., a placement that takes EITHER Flashtalking-served `html5` OR an internal `display_tag`; a video product that accepts a hosted upload OR a VAST tag). Buyers pick which option they're shipping at `sync_creatives` time by aligning their manifest to the matching declaration's `format_kind`. Mutually exclusive with `format_ids` via the existing `oneOf`.
- **`status: "stable" | "preview" | "deprecated"` field on canonical format `_base.json`.** Default `stable`. Lets the spec ship not-yet-fully-settled canonicals (`agent_placement` and `responsive_creative` in 3.1) with explicit notice that their parameter shape and tracking model MAY break in 3.2 once 2-3 adopters have built against them. The other 9 canonicals are anchored in stable IAB / platform standards and stay `stable`.

**Doc changes:**

- **Worked example: third-party creative agent path (Flashtalking + NYTimes display).** Adds a multi-actor walkthrough alongside the existing single-actor host-read example: buyer reads NYTimes capabilities → sees declared `creative_agents` and the resolved `supported_formats` projection → calls Flashtalking's `build_creative` → ships the manifest to NYTimes via `sync_creatives`. The seller validates against the canonical, NOT against Flashtalking's narrowing — that's the creative agent's contract with the buyer. Closes a gap where the r4 collapse of `build_capability` into format slots wasn't documented for the third-party-creative-agent flow.
- **Platform extension hosting expectations.** Adds a paragraph to the "Platform extensions — distribution" section documenting hosting role (publisher's subdomain hosts the canonical artifact), caching expectations (`Cache-Control: public, max-age=31536000, immutable` enabled by digest pinning), availability targets (≥99.9% / 30 days), and graceful-degradation semantics on 404 (treat extension as unavailable; don't fail the buy). AAO mirror is best-effort fallback, not normative.
- **Adoption-driven `format_ids` removal trigger.** v1 `format_ids` is removed in 5.0 — but the trigger is adoption-driven, not date-driven. AAO computes the ratio of registered sales agents declaring `format_options` from cached `get_products` capabilities responses. When `format_options` adoption crosses 80% and stays there for 30 consecutive days, the 5.0 cut sequence opens. Until then, both shapes remain valid.

**Schema housekeeping:**

- Added a description note on `validate-input-response.json` documenting the intent behind the 3-schema split (`request` / `response` / `result`): the `Result` type is split for planned reuse by adjacent async-validation surfaces (per-batch result envelopes on `build_creative` async paths, asynchronous canonical-against-product validation in `sync_creatives`). Producers that only need the synchronous batch shape today MAY treat the split as YAGNI; the schema reuse anchors the violation/retry shape so downstream surfaces don't drift.
- Updated all 12 v2 reference fixtures (`static/examples/products/v2/*.json`) plus the `meta_with_bundled_extensions.json` get_products response fixture to use the new `format_options` array shape. All 13 fixtures still validate via `npm run test:v2-fixtures`.
- Updated `tests/schema-validation.test.cjs` core-required-fields rule to assert `format_options` (not `format`) on the v2 oneOf branch.

**Why minor:** structural rename of `product.format` → `product.format_options` is technically breaking for anyone who built against the v2 path during the preview window, but the v2 path was only landed in this PR (#3307) and is not yet released — no published 3.x version carries `format`. The shipping shape is `format_options`. Anyone building against the preview branch should re-pull. The other changes are additive.

Tracks #3305 (v2 RFC) and #3307 (preview branch).
