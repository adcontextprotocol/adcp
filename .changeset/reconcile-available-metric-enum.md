---
"adcontextprotocol": minor
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
  `new_to_brand_rate`). Notes platform variance for `saves`
  (Pinterest "repins", TikTok "video_saves").
- `docs/media-buy/task-reference/create_media_buy.mdx`: `requested_metrics`
  examples updated to `completed_views`.
- `server/src/training-agent/publishers.ts`: training-agent fixture
  `reportingMetrics` arrays use `completed_views`.

**Vocabulary provenance.** `completed_views` and `engagements` follow IAB/MRC
and VAST 4 conventions. `follows`, `saves`, and `profile_visits` are
platform-native names (Meta/TikTok/Pinterest); AdCP is setting these as the
canonical aliases for cross-platform reporting since IAB does not define
social-platform engagement scalars.

**Backwards compatibility.** Removing `video_completions` from the enum is a
validation-constraint change — minor-bumped per the schema-publication-at-merge
policy. Any seller that had populated `available_metrics: ["video_completions"]`
was already non-functional (no `video_completions` field in delivery responses
to populate, only `completed_views`). Buyers that filtered against
`video_completions` on the discovery side should switch to `completed_views`.

This unblocks a follow-up that adds `required_metrics` to `get_products` and
`missing_metrics` to `get_media_buy_delivery` for end-to-end metric
accountability through the media buy lifecycle.

**DBCFM KPI cross-reference.** The DBCFM `Reporting`/`Performance` KPI
vocabulary has not been mapped into AdCP (PRs #1594, #1605, #1664 covered
price/business-entities/proposal-lifecycle; measurement block is out of
scope). No string-level or semantic collision exists at merge time. When the
DBCFM measurement mapping is eventually added, note that `engagements`
corresponds to DBCFM `Interaktionen`, `follows` to `Follower-Gewinn`, `saves`
to `Gespeichert`, and `profile_visits` to `Profilbesuche`. No aliasing is
required — the AdCP names are unambiguous — but a cross-reference note will be
needed in the DBCFM mapping doc (tracked in #3460).

**`completion_rate` is a derived ratio.** `completion_rate =
completed_views / impressions` — it is derivable, not independently
reportable. The planned `missing_metrics` check in `get_media_buy_delivery`
must treat ratio metrics as derivable to avoid false
`metric_accountability_breach` hints. This is a design signal for the
`required_metrics`/`missing_metrics` follow-up; it does not affect this PR.
