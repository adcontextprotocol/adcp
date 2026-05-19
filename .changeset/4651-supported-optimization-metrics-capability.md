---
"adcontextprotocol": minor
---

feat(schemas): add media_buy.supported_optimization_metrics seller-level summary (closes #4651)

Sellers can now declare which optimization metrics they support at the seller level, mirroring the product-level `metric_optimization.supported_metrics` enum. Buyer agents get a single discoverable rollup for pre-flight metric filtering; storyboard scenarios get a gate path they can use with `requires_capability` to skip sellers that don't support a metric (e.g., reach_buy_flow, clicks_buy_flow, completed_views_buy_flow).

Sellers MUST keep this in sync with their product catalog — values appear here only if at least one product supports them. Per-product inspection via `metric_optimization.supported_metrics` remains the source of truth for buy-time targeting; this is a seller-level discoverability convenience.

Unblocks the metric-buy-mode storyboards under the capability-claim contract pattern (#4637). Those scenarios additionally require a `contains:` matcher on `requires_capability` (filed against adcp-client).
