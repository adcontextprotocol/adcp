---
---

feat(compliance): pagination integrity for get_media_buys — handler fix + storyboard

Adds cursor-based pagination to `handleGetMediaBuys` in the training agent and a new
`get-media-buys-pagination-integrity.yaml` conformance storyboard, completing the fourth
entry in the rolling pagination conformance series (#3095 list_creatives, #3100 total_count
honesty, #3109 get_signals).

Handler changes: reads `pagination.max_results` (default 50, cap 100), decodes a
namespaced `mb:offset:<n>` cursor (base64url), slices the post-filter buy set, and emits
`pagination: { has_more, total_count, cursor? }`. Pagination is skipped when `media_buy_ids`
is provided — that is a direct lookup, not a paginated broad-scope query per the request
schema semantics. Malformed cursors return `INVALID_REQUEST`. The `mb:` namespace prefix
ensures a `get_media_buys` cursor is rejected by `list_creatives` and vice versa, preventing
silent wrong-offset reads if a caller passes the wrong token.

Storyboard: seeds three active media buys via `controller_seeding`, walks first page
(max_results=2, asserts has_more=true + cursor present) and terminal page (asserts
has_more=false + cursor absent). No `query_summary` assertions — the response schema does not
define that field for `get_media_buys`.

No protocol schema changes — `pagination` was already an optional field in
`get-media-buys-response.json`. Existing callers unaffected: `media_buy_ids` lookups still
return all requested buys without a pagination envelope; broad-scope queries with small
fixture sets (≤50) return all results in a single page with `has_more: false`.
