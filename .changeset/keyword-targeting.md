---
"adcontextprotocol": minor
---

Add keyword targeting for search and retail media platforms.

New fields in `targeting_overlay`:
- `keyword_targets` — array of `{keyword, match_type, bid_price?}` objects for search/retail media targeting. Per-keyword `bid_price` overrides the package-level bid for that keyword and inherits `max_bid` interpretation from the pricing option. Keywords identified by `(keyword, match_type)` tuple.
- `negative_keywords` — array of `{keyword, match_type}` objects to exclude matching queries from delivery.

New fields in `package-update` (incremental operations):
- `keyword_targets_add` — upsert keyword targets by `(keyword, match_type)` identity; adds new keywords or updates `bid_price` on existing ones
- `keyword_targets_remove` — remove keyword targets by `(keyword, match_type)` identity
- `negative_keywords_add` — append negative keywords to a live package without replacing the existing list
- `negative_keywords_remove` — remove specific negative keyword+match_type pairs from a live package

New field in delivery reporting (`by_package`):
- `by_keyword` — keyword-grain breakdown with one row per `(keyword, match_type)` pair and standard delivery metrics

New capability flags in `get_adcp_capabilities`:
- `execution.targeting.keyword_targets`
- `execution.targeting.negative_keywords`

New reporting capability:
- `reporting_capabilities.supports_keyword_breakdown`
