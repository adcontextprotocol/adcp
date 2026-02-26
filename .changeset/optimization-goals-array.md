---
"adcontextprotocol": minor
---

Redesign optimization goals with multiple event sources, threshold rates, and attention metrics.

- `optimization_goal` (singular) → `optimization_goals` (array) on packages
- `OptimizationGoal` is a discriminated union on `kind`:
  - `kind: "event"` — optimize for advertiser-tracked conversion events via `event_sources` array of source-type pairs. Seller deduplicates by `event_id` across sources. Each entry can specify `value_field` and `value_factor` for value-based targets.
  - `kind: "metric"` — optimize for a seller-native delivery metric with optional `cost_per` or `threshold_rate` target
- Target kinds: `cost_per` (cost per unit), `threshold_rate` (minimum per-impression value), `per_ad_spend` (return ratio on event values), `maximize_value` (maximize total conversion value)
- Metric enum: `clicks`, `views`, `completed_views`, `viewed_seconds`, `attention_seconds`, `attention_score`, `engagements`, `follows`, `saves`, `profile_visits`
- Both kinds support optional `priority` (integer, 1 = highest) for multi-goal packages
- `product.conversion_tracking.supported_targets`: `cost_per`, `per_ad_spend`, `maximize_value`
- `product.metric_optimization.supported_targets`: `cost_per`, `threshold_rate`
