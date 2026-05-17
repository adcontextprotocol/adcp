---
"adcontextprotocol": minor
---

feat(schemas): add `supported_target_kinds` to `conversion_tracking` capability.

The seller-level `conversion_tracking` capability object on `get_adcp_capabilities` has no way to declare which event-goal `target.kind` values it can compute against. Today the spec requires sellers to reject `target.kind: per_ad_spend` event goals when no `event_sources[]` entry carries `value_field` (`static/schemas/source/core/optimization-goal.json`), but buyers have no pre-submission signal — they discover the constraint only at `create_media_buy` rejection time.

`supported_target_kinds` is an optional array on the existing `conversion_tracking` object, enum-constrained to `cost_per | per_ad_spend | maximize_value`, paralleling the product-level `metric_optimization.supported_targets`. Buyers filter their event-goal shape against this list before submission; sellers MUST reject goals whose `target.kind` is not listed. When omitted, only target-less event goals (maximize conversion count within budget) are guaranteed.

Purely additive and backward-compatible — no existing field changes, no requireds. Unblocks a future `performance_buy_flow_roas` storyboard scenario (capability-gated) without coupling that scenario to this schema PR.

Files:
- `static/schemas/source/protocol/get-adcp-capabilities-response.json` — new optional `supported_target_kinds` property on the `conversion_tracking` object.

Refs #4569, #4637. Closes #4639.
