---
"adcontextprotocol": minor
---

Close two reporting gaps on `core/delivery-metrics.json`: optimization metrics that had no reporting-side counterpart, and ambiguous reach/frequency measurement windows.

**Attention / duration delivery scalars (#4579).** Add `viewed_seconds`, `attention_seconds`, and `attention_score` to `delivery-metrics.json`. These mirror the same-named `metric` enum values in `optimization-goal.json` — buyers could set a duration- or attention-based optimization goal, but had no standard delivery field to receive the reported value against. With this minor:

- `viewed_seconds: number` — average seconds in view per impression.
- `attention_seconds: number` — average attention time per impression. Vendor-defined; vendor identity flows through `committed_metrics.vendor` / `performance_standards.vendor` when committed, or `vendor_metric_values` when not graduated.
- `attention_score: number` — vendor-defined per-impression score. Same vendor-identity pattern as `attention_seconds`.

Sellers reporting against a duration/attention optimization goal MUST populate the matching delivery field; absent values indicate no seller-native measurement.

**`reach_window` for reach/frequency disambiguation (#4580).** Add `reach_window` to declare the measurement window for reported `reach` and `frequency`. Before this minor, a buyer summing `reach` across daily delivery rows could silently double-count audiences — a seller could legitimately report daily uniques, cumulative-to-date uniques, or a custom window, with no way for the buyer to tell. With this minor:

- `reach_window: { kind: "cumulative" | "period", period?: Duration }`. `cumulative` = rolling uniques since campaign start (do not sum across rows; each later row supersedes); `period` = uniques within the reporting window only (e.g., a daily snapshot).
- `reach` and `frequency` descriptions updated to reference `reach_window`. When `reach_window` is omitted, the window is unspecified — buyers MUST NOT sum reach across rows or compare/average frequency across rows.
- Sellers SHOULD populate `reach_window` whenever `reach` is present. Not made hard-required for backwards compatibility, but the description language is prescriptive.

**Backwards compatibility.** Additive. All four new fields are optional. Existing sellers continue to validate without changes; existing buyers ignoring the new fields keep working. Buyers SHOULD upgrade their reach summation logic to gate on `reach_window` semantics.

**Doc updates.** Metrics tables in `docs/media-buy/task-reference/get_media_buy_delivery.mdx` and `docs/creative/task-reference/get_creative_delivery.mdx` reflect the new fields.

Closes #4579, #4580.
