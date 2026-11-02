---
"adcontextprotocol": minor
---

Add experimental spot lifecycle and break position to `by_spot[]` in `get_media_buy_delivery` (#5683 report-time half, #8009 reporting half; booking and contract-time preemption criteria stay open for 3.4). New optional `spot_status` (`scheduled | aired | preempted | makegood`, new `enums/spot-status.json`), `scheduled_at`, `replaces_spot_id` (`x-entity: spot_airing`), and `break_position` (`position_in_break`, `spots_in_break`, optional `break_id`). One `spot_id` tracks from `scheduled` to `aired` or `preempted`; a `makegood` row carries `replaces_spot_id`. Metrics on `scheduled` rows are expectations, not actuals. Sellers declare what they report in `supports_spot_breakdown.available_statuses` and `supports_break_position`, so a missing row or field is not read as non-delivery. The cluster is `media_buy.spot_lifecycle` in the experimental registry.

Compatibility: `aired_at` is now required only on `aired` and `makegood` rows and on rows with no `spot_status` (which mean `aired`), so existing 3.2 documents stay valid. Rows are ordered ascending by `aired_at`, else `scheduled_at`. Sellers MUST NOT send `scheduled` or `preempted` rows, or the new capability fields, to callers pinned below AdCP 3.3, because 3.2 validators require `aired_at` on every row and `spot-reporting-capability.json` is closed.
