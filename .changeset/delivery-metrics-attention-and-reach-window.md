---
"adcontextprotocol": minor
---

Close two reporting gaps on `core/delivery-metrics.json`: a duration metric that had no reporting-side counterpart, and ambiguous reach/frequency measurement windows. Attention metrics (#4579) are intentionally **not** added as flat scalars — see below.

**`viewability.viewed_seconds` (#4579, partial).** Extend the existing `viewability` block to include `viewed_seconds` — average in-view duration per measurable impression. Buyers can already set `viewed_seconds` as an optimization goal in `optimization-goal.json`; this gives them a place to receive the reported value back. Nested into `viewability` rather than added as a top-level scalar because the viewability `standard` governs the in-view threshold for both `viewable_rate` and `viewed_seconds`, and they share the same `measurable_impressions` denominator. The vendor identity is already carried on the parent block.

**Attention metrics (#4579, remainder).** `attention_seconds` and `attention_score` are intentionally **not** added as graduated delivery-metrics fields. Per `docs/measurement/taxonomy.mdx`, vendor-specific metrics with no industry-graduated standard flow through `vendor_metric_values` — every attention vendor (DoubleVerify, IAS, Adelaide, TVision, Lumen, …) defines them differently with no MRC-or-equivalent accreditation. The reporting path is `vendor_metric_values[]` with `metric_id: "attention_seconds"` or `"attention_score"` and the vendor identified on the row. The `optimization-goal.json` metric enum description is updated to point reporters at this path so the optimization-side and reporting-side stay aligned without schema-graduating these vendor-specific metrics.

**`reach_window` for reach/frequency disambiguation (#4580).** Add `reach_window` to declare the measurement window for reported `reach` and `frequency`. Before this minor, a buyer summing `reach` across daily delivery rows could silently double-count audiences — a seller could legitimately report daily uniques, cumulative-to-date uniques, or a custom window, with no way for the buyer to tell. With this minor:

- `reach_window: { kind: "cumulative" | "period", period?: Duration }`. `cumulative` = rolling uniques since campaign start (do not sum across rows; each later row supersedes); `period` = uniques within the reporting window only (e.g., a daily snapshot).
- `reach` and `frequency` descriptions updated to reference `reach_window`. When `reach_window` is omitted, the window is unspecified — buyers MUST NOT sum reach across rows or compare/average frequency across rows.
- Sellers SHOULD populate `reach_window` whenever `reach` is present. Not made hard-required for backwards compatibility, but the description language is prescriptive.

**Backwards compatibility.** Additive. `viewability.viewed_seconds` and `reach_window` are both optional. Existing sellers continue to validate without changes; existing buyers ignoring the new fields keep working. Buyers SHOULD upgrade their reach summation logic to gate on `reach_window` semantics.

**Doc updates.** Metrics tables in `docs/media-buy/task-reference/get_media_buy_delivery.mdx` and `docs/creative/task-reference/get_creative_delivery.mdx` reflect the changes.

Closes #4580. Addresses #4579 partially (viewed_seconds added; attention metrics routed via vendor_metric_values).
