---
"adcontextprotocol": minor
---

Add five missing scalar metrics that production reporting carries today
but had no enum entry: `cost_per_completed_view`, `cpm`, `downloads`,
`units_sold`, `new_to_brand_units`. Closes the missing-scalars sub-item
of #3460.

**The scalars and where they fit.**

- `cost_per_completed_view` — CTV CPCV pricing scalar. Parallels existing
  `cost_per_click` and `cost_per_acquisition`; the package's
  `pricing_model` is `cpcv` when this field is the billing basis.
- `cpm` — Cost per thousand impressions. Universal pricing scalar across
  CTV, display, mobile/web video, native, audio, and DOOH inventory.
  Conspicuous absence next to `cost_per_click` before this PR; the
  package's `pricing_model` is `cpm` when this field is the billing
  basis. Field name aligns with the canonical `cpm` token in
  `pricing-model.json` and `pricing-options/cpm-option.json` so buyers
  cross-walk pricing model → reported scalar without a translation.
- `downloads` — IAB-standard scalar for audio/podcast inventory (IAB
  Podcast Measurement Technical Guidelines 2.x methodology). Distinct
  from `views`.
- `units_sold` — Retail-media commerce scalar. Distinct from
  `conversions` (a single transaction may carry multiple units).
  Attribution windows are platform-specific; sellers SHOULD declare the
  window via `reporting_capabilities.measurement_windows` or
  `measurement_terms` rather than encoding it in this scalar.
- `new_to_brand_units` — Retail-media count of units sold to first-time
  brand buyers. Unit-volume parallel to existing `new_to_brand_rate`
  (which carries the fraction-of-conversions metric); this is the
  absolute unit count.

**Wired in.**

- `enums/available-metric.json`: five new enum values appended.
- `core/delivery-metrics.json`: five new properties (`type: number,
  minimum: 0`) added next to `cost_per_click`. Existing `new_to_brand_rate`
  description tightened to clarify it is the fraction of `conversions`
  (transactions), distinguishing it from the new units count.
- `docs/media-buy/media-buys/optimization-reporting.mdx`: metric list
  updated.

**Sub-items already resolved on #3460.**

- **Closed-vs-open enum** — resolved by #3492 (vendor-metric extensions).
  Closed enum stays closed; vendor-defined metrics live in the parallel
  structured `vendor_metrics` surface anchored on the vendor's brand.json.
- **`completion_rate` derived ratio** — resolved by the drop-carve-out
  call in #3472's refactor. `missing_metrics` is the symmetric mirror of
  `available_metrics` with no carve-outs.

**Sub-item that remains as a follow-up.**

- **DBCFM cross-check with David Porzelt** on whether
  `engagements`/`follows`/`saves`/`profile_visits` (added in #3453)
  collide with DBCFM `Reporting`/`Performance` KPI codes. Human contact;
  not a code change.

**Backwards compatibility.** All additions are optional. Existing reports
without these scalars stay conformant; sellers that adopt them populate
the new fields when applicable.

Closes #3460.
