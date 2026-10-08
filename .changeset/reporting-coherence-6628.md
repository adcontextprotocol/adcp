---
"adcontextprotocol": minor
---

Settle deferred delivery-reporting coherence items from #6628. `missing_metrics` now states that a committed leaf is satisfied only by the package's own totals row, not a breakdown row (e.g. `quartile_75` → `quartile_data.q3_views`). `time_based_views` is omitted when not applicable to the package, and `[]` means applicable with no qualifying rows. `reporting_dimensions.demographic` in `get-media-buy-delivery-request.json` no longer sets `additionalProperties: false`, aligning with DR-0009 (a loosening, non-breaking change). Dropped the stale "each buy is single-qualifier by definition" sentence from `aggregated_totals.metric_aggregates`, added a `completion_rate` denominator note to the optimization-reporting guide, and added a conformance-grading note that graders must not verify ordering from response bodies when `requested_metrics` excludes the sort metric.
