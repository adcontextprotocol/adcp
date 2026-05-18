---
"adcontextprotocol": minor
---

feat(compliance): metric-mode (reach/clicks/completed_views) + ROAS capability-gated scenarios using contains: matcher

Four new scenarios in the capability-claim contract pattern (#4637), all gated via the `contains:` matcher (shipped in @adcp/client 7.70 — adcp-client#1817), all added to `sales-non-guaranteed.requires_scenarios`:

- `media_buy_seller/performance_buy_flow_roas` — gated on `media_buy.conversion_tracking.supported_targets` containing `per_ad_spend` (#4639). Certifies that sellers advertising ROAS optimization accept event-kind goals with `target.kind: per_ad_spend` and `value_field` populated, reject ROAS goals that omit `value_field` on every event source entry, and report `conversion_value` and `roas` on delivery alongside `conversions` and `cost_per_acquisition`. Sibling to `performance_buy_flow` on the value side.

- `media_buy_seller/reach_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `reach` (#4669). Certifies that sellers advertising reach optimization accept metric-kind goals with `metric: reach`, a `reach_unit` from the product's `metric_optimization.supported_reach_units`, and an optional `target_frequency` band; reject unsupported `reach_unit` values; and report `reach` and `frequency` on delivery.

- `media_buy_seller/clicks_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `clicks` (#4669). Certifies that sellers advertising click optimization accept metric-kind goals with `metric: clicks` and a `cost_per` target, and report `clicks` and `cost_per_click` on delivery. No rejection arm — clicks is universal in semantics with no obvious unbound-id surface.

- `media_buy_seller/completed_views_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `completed_views` (#4669). Certifies that sellers advertising completion optimization accept metric-kind goals with `metric: completed_views` and a `view_duration_seconds` in the product's `metric_optimization.supported_view_durations`; reject unsupported `view_duration_seconds` values (per `optimization-goal.json:50-53`, silent rounding creates measurement discrepancies); and report `completed_views` and `completion_rate` on delivery.

All four scenarios grade `not_applicable` against the embedded training agent today — the training agent doesn't declare `supported_targets` or `supported_optimization_metrics` and therefore cannot claim these optimization kinds. This is the correct anti-façade hygiene per the `event_dedup_flow` precedent (#4664): an agent that doesn't claim a capability is not held to its scenario. The training agent stays honest by NOT claiming what it can't do; production adopters opt in by declaring the capability bits.

Refs: #4637 (meta), #4639 (`supported_targets`), #4669 (`supported_optimization_metrics`), #4642 (CPA scenario precedent), #4664 (`event_dedup_flow` precedent), #4651 (product-level capability gating), adcp-client#1817 (`contains:` matcher).
