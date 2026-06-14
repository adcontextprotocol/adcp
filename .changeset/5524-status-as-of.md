---
"adcontextprotocol": minor
---

Add optional `status_as_of` freshness timestamp to `get_media_buys` media-buy objects.

The field lets sellers identify when a returned media-buy-level `status` was last refreshed from the source of truth, covering cached or rolled-up list reads from curator/storefront aggregators. Sellers omit it or return `null` when status is live or freshness is unknown.
