---
"adcontextprotocol": minor
---

feat(compliance): per_creative_attribution capability bit + scenario

New capability bit and scenario in the capability-claim contract pattern (#4637), landing the deferred per-creative conversion attribution work from #4642 / #4725.

- `media_buy.conversion_tracking.per_creative_attribution` (boolean, defaults to false) — `static/schemas/source/protocol/get-adcp-capabilities-response.json`. Declares whether the seller can attribute conversions to specific creatives within a package and surface that breakdown via `media_buy_deliveries[].by_package[].by_creative[].conversions` in `get_media_buy_delivery`. Optional; omission means `false` and is backward-compatible.
- `media_buy_seller/per_creative_conversion_attribution` — new scenario gated on `media_buy.conversion_tracking.per_creative_attribution: true`, added to `sales-non-guaranteed.requires_scenarios`. Registers two distinct display creatives via `sync_creatives`, creates a media buy whose single package's `creative_assignments` references both, logs two purchase events against the bound event source, simulates delivery, and asserts `by_package[0].by_creative[0..1].{creative_id,conversions}` are populated. The second-row assertion is the asymmetry check that separates honest per-creative attribution from a single-row façade collapsing attribution to whichever creative the seller tracked first.

Closes the gap deliberately left by `performance_buy_flow` (#4642), whose narrative explicitly defers per-creative attribution: honest adopters report at differing granularities — social platforms per-ad, retail-media networks (Criteo, Amazon Ads) per-line, MMP-mediated mobile (post-iOS-14) per-campaign / per-ad-set, broadcast and CTV performance products per-placement. Requiring per-creative in the base CPA scenario would have failed those honest implementations. The bit gates the scenario; sellers that don't advertise it grade `not_applicable`.

`log_event`'s payload (`core/event.json`) does NOT carry `creative_id` — attributing each event back to a specific creative is the seller's internal click / view-through correlation, not the buyer's. The scenario logs two events with distinct `event_ids` and relies on the seller's correlation to spread `simulate_delivery`'s `conversions` count across the two assigned creatives in the `by_creative[]` breakdown.

No training-agent changes — the training agent does not declare `per_creative_attribution`, so the scenario grades `not_applicable` against the reference implementation and CI passes. Same anti-façade pattern as `event_dedup_flow` (#4664) and `frequency_cap_enforcement` (#4640): the bit gates the scenario, the assertion targets the runtime behavior the bit commits to.

Refs: #4725 (capability bit + scenario), #4637 (capability-claim meta), #4642 (performance_buy_flow that deferred this), #4639 (supported_targets bit for the sibling ROAS gate).
