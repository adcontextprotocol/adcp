---
"adcontextprotocol": patch
---

Reconcile `available-metric` enum with `delivery-metrics.json` so every
declarable metric has a corresponding property in the delivery payload.

**Why.** A buyer that says "I can only use products that report
`completed_views`" only has accountability if the enum used at the discovery
layer is a 1:1 mirror of what reporting can actually return. The enum had
drifted from the property set:

- `video_completions` was listed in the enum but had no corresponding property
  in `delivery-metrics.json` — the property was renamed to `completed_views`
  in a prior release (per `docs/reference/release-notes.mdx` §7) and the enum
  alias was never cleaned up. A seller declaring it in `available_metrics`
  was advertising a metric they could not report.
- Four scalar properties on `delivery-metrics.json` (`engagements`, `follows`,
  `saves`, `profile_visits`) had no enum entries, so a product that reports
  social/social-platform engagements had no way to declare so at discovery.

**Changes.**

- `enums/available-metric.json`: remove `video_completions`; add `engagements`,
  `follows`, `saves`, `profile_visits`. Object/namespace entries (`viewability`,
  `quartile_data`, `dooh_metrics`) remain — they map to namespace properties
  in `delivery-metrics.json`.
- `core/reporting-capabilities.json`: example updated to use `completed_views`.
- `docs/media-buy/media-buys/optimization-reporting.mdx`: metric list rewritten
  to match the reconciled enum (drops the stale `video_completions` entry,
  adds `engagements` / `follows` / `saves` / `profile_visits` /
  `new_to_brand_rate`).
- `docs/media-buy/task-reference/create_media_buy.mdx`: `requested_metrics`
  examples updated to `completed_views`.
- `server/src/training-agent/publishers.ts`: training-agent fixture
  `reportingMetrics` arrays use `completed_views`.

**Backwards compatibility.** Any seller that had populated
`available_metrics: ["video_completions"]` was already non-functional — there
is no `video_completions` field in delivery responses to populate, only
`completed_views`. Buyers that filtered against `video_completions` on the
discovery side should switch to `completed_views`.

This unblocks a follow-up that adds `required_metrics` to `get_products` and
`missing_metrics` to `get_media_buy_delivery` for end-to-end metric
accountability through the media buy lifecycle.
