---
"adcontextprotocol": minor
---

Redesign optimization goals to support multiple goals, metric targets, and explicit priority ordering.

- `optimization_goal` (singular) → `optimization_goals` (array) on packages
- `OptimizationGoal` is now a discriminated union on `kind`:
  - `kind: "event"` — optimize for an advertiser-tracked conversion event (purchase, lead, app_install, etc.) with `target.kind: "cpa" | "roas"`
  - `kind: "metric"` — optimize for a seller-native delivery metric (clicks, views, completed_views) with `target.kind: "cpc" | "cpv" | "cpcv"`
- Both kinds support an optional `priority` field (integer, 1 = highest) for multi-goal packages
- `product.conversion_tracking.supported_optimization_strategies` extended with `target_cpc`, `target_cpv`, `target_cpcv`
