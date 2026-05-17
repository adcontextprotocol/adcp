---
"adcontextprotocol": minor
---

feat(compliance): add `media_buy_seller/performance_buy_flow` capability-gated scenario (closes #4569)

A non-guaranteed seller that advertises `media_buy.conversion_tracking` now has its performance-buy path certified end-to-end. The new scenario gates on the conversion_tracking capability via `requires_capability: present: true` (runner support landed in `@adcp/client` 7.6.0) — sellers without the capability grade `not_applicable`.

The scenario verifies the dots actually connect when a seller claims conversion tracking:

- `sync_event_sources` returns a usable `event_source_id`.
- `create_media_buy` with an event-kind `optimization_goal` (CPA target) referencing the registered source is accepted.
- `create_media_buy` with a goal referencing an unregistered `event_source_id` is rejected with `INVALID_REQUEST` and `error.field` set to the offending path — silent acceptance is a façade.
- `log_event` against the bound source is forwarded upstream (anti-façade `upstream_traffic` assertion).
- `get_media_buy_delivery` returns first-class conversion metrics: `conversions`, `cost_per_acquisition`, and `by_package[].by_creative[].conversions`. Buyers need per-creative attribution to know which creatives drove the goal.

ROAS (`target.kind: per_ad_spend`) and value-max (`target.kind: maximize_value`) are deliberately out of scope here — many honest conversion-tracking sellers (broadcast TV, upper-funnel video, signal-only) don't compute return-on-ad-spend. ROAS gets its own scenario gated on a separate `supported_target_kinds` capability bit ([#4639](https://github.com/adcontextprotocol/adcp/issues/4639)).

This is the first scenario in a broader capability-claim contract pattern tracked under [#4637](https://github.com/adcontextprotocol/adcp/issues/4637): every non-trivial capability a seller declares should have a `requires_capability`-gated scenario proving the claim is honest end-to-end.

**Added to `sales-non-guaranteed.requires_scenarios`.**
