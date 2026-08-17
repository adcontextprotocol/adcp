---
"adcontextprotocol": minor
---

Add capability-gated delivery breakdowns by canonical creative `format_kind` to `get_media_buy_delivery`, including explicit GET-only scope, `custom` aggregation, truncation disclosure, independent reconciliation from creative-level rows, and the full sort contract (`sort_direction` plus the `by_format_sorted_by`/`by_format_sort_direction` applied-sort echo with row-grain fallback and nulls-last semantics).
