---
---

compliance: add catalog→creative coverage to sales-social, creative-generative, sales-retail-media (#2640)

Closes #2640 (partial — retail-media full flow deferred to its 3.1 epic per the specialism's placeholder).

The audit in #2638 / #2640 surfaced that only `sales-catalog-driven` exercised catalog→creative flow in its storyboard. Three other catalog-relevant specialisms had no catalog-sync phase despite their production equivalents routinely handling catalogs:

- `sales-social` — Snap Dynamic Ads, Meta DPA, TikTok Dynamic Showcase are all catalog-driven
- `creative-generative` — generative DSPs routinely hydrate catalog items into the generation context
- `sales-retail-media` — Amazon Ads, Walmart Connect, Target Roundel, Kroger Precision are almost entirely catalog/SKU-driven

This PR adds phases that establish the catalog-acceptance plumbing on each.

**Mixed scope** — depth calibrated per specialism:

- `sales-social/index.yaml`: new `catalog_driven_dynamic_ads` phase inserted between `creative_push` and `event_logging`. Two steps: `sync_catalogs` with an inline product catalog, then `sync_creatives` pushing a DPA template whose tracker URLs include `{SKU}` and `{GTIN}` catalog-item macros. Acme-outdoor test-kit.
- `creative-generative/index.yaml`: new `catalog_augmented_generation` phase at the end. Two steps: `sync_catalogs` with a small inline feed, then `build_creative` generating a catalog-bound creative with `include_preview: true` (natural observation point for the substitution-safety runtime check in #2638).
- `sales-retail-media/index.yaml`: was `phases: []` (3.1 placeholder). Now has one `catalog_acceptance` phase using the summit-foods test-kit (the retail-media-specific fixture). Narrative explicitly flags that the full retail-media flow lands with the retail-media epic.

`required_tools` updated on each specialism to include `sync_catalogs` (and `sync_creatives` on sales-social).

**Out of scope (follow-ups):**

- Runtime substitution-safety check (#2638) — requires the `substitution_observer_runner` test-kit contract that doesn't exist yet. Phases in this PR establish the catalog→creative flow that #2638's runtime check will hang on.
- Full retail-media buy-to-attribution flow — deferred to the retail-media epic (tracked via #2640's retail-media section).
- DPA-specific format schemas, per-platform DPA behaviors (Meta, Snap, TikTok) — this PR uses a platform-agnostic `dynamic_product_feed` format_id as placeholder; specialism-specific refinement can come with implementer input.

No schema change. No spec change. Existing phases on each specialism unchanged.
