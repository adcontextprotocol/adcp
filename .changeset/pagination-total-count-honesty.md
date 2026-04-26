---
---

Extends `pagination_integrity` with count-honesty assertions that complement the cursor↔has_more invariant. Each page now asserts `query_summary.total_matching = 3`, `query_summary.returned` matches the slice (2 then 1), and `pagination.total_count` equals 3 when volunteered (`field_value_or_absent` so omitting it stays conformant per the schema).

Catches the dishonest pagination class where an agent honors `max_results` and the cursor handshake but lies in the summary numbers — under-reporting `total_count` to hide inventory the same way a dishonest `has_more: false` would, or drifting `total_matching` between pages. Verified by spot-flipping the training agent's `total_count` to the page-local count: page-1 assertion fires with the expected diagnostic.
