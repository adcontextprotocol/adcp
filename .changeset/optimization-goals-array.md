---
"adcontextprotocol": minor
---

Redesign optimization goals to support multiple goals, metric targets, and explicit priority ordering.

- `optimization_goal` (singular) → `optimization_goals` (array) on packages
- `OptimizationGoal` is now a discriminated union on `kind`:
  - `kind: "event"` — optimize for an advertiser-tracked conversion event (purchase, lead, app_install, etc.) with `target.kind: "cost_per" | "per_ad_spend"`
  - `kind: "metric"` — optimize for a seller-native delivery metric (clicks, views, completed_views) with `target.kind: "cost_per" | "rate"`
- Event goals with `per_ad_spend` targets require `value_field` to identify the monetary value field on event custom_data
- Both kinds support an optional `priority` field (integer, 1 = highest) for multi-goal packages
- `product.conversion_tracking.supported_optimization_strategies` uses `target_cost_per`, `target_rate`, `target_per_ad_spend`
