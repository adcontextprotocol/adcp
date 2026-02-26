---
"adcontextprotocol": minor
---

Add capability declarations for metric optimization goals, cross-channel engagement metrics, video view duration control, and value optimization.

**New metric kinds** (`optimization_goals` with `kind: 'metric'`):
- `engagements` — direct ad interaction beyond viewing: social reactions/comments/shares, story/unit opens, interactive overlay taps on CTV, companion banner interactions on audio
- `follows` — new followers, page likes, artist/podcast/channel subscribes
- `saves` — saves, bookmarks, playlist adds, pins
- `profile_visits` — visits to the brand's page, artist page, or channel

**Video view duration control:**
- `view_duration_seconds` on metric goals — minimum view duration (in seconds) that qualifies as a `completed_views` event (e.g., 2s, 6s, 15s). Sellers declare supported durations in `metric_optimization.supported_view_durations`. Sellers must reject unsupported values.

**New event goal target kind:**
- `maximize_value` — maximize total conversion value within budget without a specific ROAS ratio target. Steers spend toward higher-value conversions. Requires `value_field` on event sources.

**Product schema additions:**
- `metric_optimization` — declares which metric kinds a product can optimize for (`supported_metrics`), which view durations are available (`supported_view_durations`), and which target kinds are supported (`supported_targets`). Presence indicates support for `kind: 'metric'` goals without any conversion tracking setup.
- `max_optimization_goals` — maximum number of goals a package can carry. Most social platforms accept only 1.

**Product schema corrections:**
- `conversion_tracking.supported_optimization_strategies` renamed to `conversion_tracking.supported_targets` for consistency with `metric_optimization.supported_targets`. Both fields answer the same question: "what can I put in `target.kind`?"
- Target kind enum values aligned across product capabilities and optimization goal schemas. Product `supported_targets` values (`cost_per`, `threshold_rate`, `per_ad_spend`, `maximize_value`) now exactly match `target.kind` values on optimization goals — agents can do direct string comparison.
- `conversion_tracking` description clarified to be for `kind: 'event'` goals only.

**Delivery metrics additions:**
- `engagements`, `follows`, `saves`, `profile_visits` count fields added to delivery-metrics.json so buyers can see performance against the new metric optimization goals.
- `completed_views` description updated to acknowledge configurable view duration threshold.

**Forecastable metrics additions:**
- `engagements`, `follows`, `saves`, `profile_visits` added to forecastable-metric.json for forecast completeness.

**Capabilities schema addition:**
- `media_buy.conversion_tracking.multi_source_event_dedup` — declares whether the seller can deduplicate events across multiple sources. When absent or false, buyers should use a single event source per goal.

**Optimization goal description clarifications:**
- `event_sources` references the `multi_source_event_dedup` capability; explains first-source-wins fallback when dedup is unsupported.
- `value_field` and `value_factor` clarified as seller obligations (not optional hints). The seller must use these for value extraction and aggregation. They are not passed to underlying platform APIs.
