---
"adcontextprotocol": minor
---

Make the automatic delivery breakdowns (creative, keyword, catalog_item) optionally negotiable: including their keys in `reporting_dimensions` adds `limit`/`sort_by`/`sort_direction` control and makes the new `by_X_truncated` and applied-sort echo fields binding, so "top creatives by quartile_100" is answerable with a completeness contract. Omitting the keys preserves today's automatic behavior exactly. Implements RFC #6623.
