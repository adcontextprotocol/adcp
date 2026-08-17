---
"adcontextprotocol": minor
---

Add `sort_direction` (asc/desc, default desc) to the six sortable delivery breakdown dimensions and a per-breakdown applied-sort echo (`by_X_sorted_by` / `by_X_sort_direction`, MUST whenever the breakdown is present) so the existing silent fallback-to-spend becomes visible to buyers. Ascending sort enables bottom-N optimization queries (worst placements by viewable_rate) that cannot be recovered from a truncated descending pull.
