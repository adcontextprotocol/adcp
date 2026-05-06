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

**Red-team round (must-fix + should-fix + nits)** — substantive cleanup against three parallel red teams (protocol-expert, adtech-product-expert, docs-expert):

Schema fixes:
- Manifest v2 path. `creative-manifest.json` and `creative-asset.json` now carry `oneOf(format_id v1 path | format_kind v2 path)` with explicit `not` on each branch. New `/schemas/core/canonical-format-kind.json` enum backs the v2 path. Optional `capability_id` field disambiguates when a product's `format_options` carries multiple declarations sharing the same `format_kind`. Without this, v2 products had no v2 manifest counterpart.
- `ProductFormatDeclaration` grows `capability_id` (stable identifier for routing) and `applies_to_channels` (subset of the product's channels this declaration applies to — lets a multi-channel product carry channel-specific format_options).
- `audio_source` enum widened to match `image_source` / `video_source` (now 5-value: `buyer_uploaded | publisher_host_recorded | seller_pre_rendered_from_brief | seller_human_designed | agent_synthesized`). TTS-from-brief and studio-produced audio now expressible.
- `product.json` oneOf branches got explicit `not: required: [other]` to truly exclude both `format_ids` AND `format_options` being present.
- Stale "inputs" references in `get-adcp-capabilities-response.json supported_formats` descriptions replaced (the concept was dropped in r4 — collapsed into slots).
- `image_carousel` got a default slots declaration (`cards` slot, asset_type: object) plus a normative `card_shape` parameter documenting the per-card object structure (media + headline + landing_page_url). `assets.cards` is now the unambiguous array-under-one-key contract; per-card key conventions (card_0_headline, cards.0.headline) are forbidden.
- Slots inline default added to all 11 canonicals (previously only on 3). SDK codegen now produces typed slot lists for every canonical.
- `synthesis_nondeterministic` × `*_source` compatibility documented in `_base.json` (incompatible with `buyer_uploaded` and `publisher_host_recorded`).
- `platform-extension-ref` digest collision behavior documented (within a single response, divergent digests for the same uri MUST fail closed; across responses, divergence is normal).
- `status: preview` deprecation pathway: `since_version` + `migration_target_version` siblings on canonical `_base.json`, plus a stabilization rubric ("preview → stable when 2 adopters ship + 90 days no breaking change").
- Veo fixture used `audio_source` / `buyer_audio_acceptance` on a `video_hosted` format. Renamed to `video_source` / `buyer_video_acceptance`.

Doc additions:
- v2-overview.mdx glossary covering ~25 v2 terms.
- Asset group vocabulary table (was previously only in the JSON schema).
- "Two axes" section refined to show the unified 5-value source enum.
- Tracker assembly under seller-rendered sources documented (macro-substituted vs sync-creatives tracker block).
- "Channels not yet canonicalized" section (native, linear/addressable TV, OOH/DOOH, audio DAI, in-game, live streaming).
- Worked examples added for: generative DSP (universalads-class, `image_source: seller_pre_rendered_from_brief`), multi-format product (Flashtalking html5 OR internal display_tag), `sponsored_placement` with `item_production_model` (1 brief × N items → N creatives).
- Hosting reframed as two paths: open-ecosystem (publisher-hosted) vs closed-platform (AAO-mirror-translated, normative for walled gardens).
- `validate_input` "when to use" decision rule + comparison table with `build_creative` and `sync_creatives`.
- Discovery + validation scaling guidance (client-side filter + multi-target validate_input).
- Generative-DSP narrative weight tuned (demoted to forward-looking subsection — universalads/Pencil/AdCreative.ai are real but small share of 2026 spend).
- Creative-agent business-model paragraph clarifying that v2 disaggregation is conceptual; creative agents continue to host their produced creatives' bytes and instrument tracking via platform extensions.
- Preview canonicals stabilization rubric (`responsive_creative` and `agent_placement` re-evaluated for stable status by 3.3 if adopters land in 3.1-3.2).
- Phase 4 SDK codegen blocker callout in the status banner.
- Phase 3 fixture count reconciled (12 product fixtures + 1 response fixture).

Migration doc additions:
- v1 deprecation calendar floor + ceiling (2027-Q4 floor, 2029-Q1 ceiling) bounding the adoption-driven trigger.
- Adoption-trigger metric definition (denominator + numerator + AAO publishing surface).
- `creative_id` stability invariant across v1 ↔ v2.
- "What v2 gives you that OpenRTB doesn't" subsection (canonical-as-contract decoupling, runtime discovery, declared production source, canonical tracking model).

Cross-doc references:
- v2 preview banners on `formats.mdx`, `key-concepts.mdx`, `generative-creative.mdx`, `specification.mdx`, `implementing-creative-agents.mdx`, `asset-types.mdx` so readers landing from search have a signpost.

`asset-types.mdx` updated for v2 with `asset_group_id` framing, full v2 asset_type table including `brief` / `catalog` / `zip` / `markdown` / `webhook` / `object`.

**Production-source taxonomy (universalads / generative-DSP gap):**

The audio_hosted canonical previously handled "who renders" via `audio_source` but with a narrower 3-value enum than image/video. The asymmetry forced generative-DSP-shaped adopters to either fudge `composition_model` or invent platform extensions to express what's actually a common pattern.

This change adds:

- `image_source` on `image` — `buyer_uploaded | seller_pre_rendered_from_brief | seller_human_designed | agent_synthesized` (default `buyer_uploaded`). Plus `buyer_image_acceptance: accepted | rejected`.
- `video_source` on `video_hosted` — same enum and pattern as `image_source`. Plus `buyer_video_acceptance: accepted | rejected`.
- `item_production_model` on `sponsored_placement` — same enum, applied per catalog item. Captures the multi-output generative pattern (1 brief × N catalog items → N rendered creatives) under the existing `sponsored_placement` canonical without requiring a 12th canonical.

These are informational fields, not the binding contract — the format's `slots` declaration is the contract. The `*_source` fields let buyers pick products whose production model fits their workflow (in-house pre-rendered vs upstream creative agent vs seller-driven generative).

The v2-overview.mdx narrative now explicitly differentiates the two orthogonal axes — `composition_model` (how the surface composes per-impression: deterministic vs algorithmic) and per-canonical production source (who renders, and when). Conflating them was the gap that left generative DSPs without a clean expression in v2.

Tracks #3305 (v2 RFC) and #3307 (preview branch).
