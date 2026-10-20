---
"adcontextprotocol": minor
---

Add optional `platform_id` to `sync_event_sources` and `sync_audiences` result items, matching the platform-assigned object IDs on `sync_creatives` and `sync_catalogs`. Deprecate the existing `seller_id` result fields as compatibility aliases. Sellers reporting a platform identifier in AdCP 3.3 and later 3.x responses emit both fields with identical values; buyers prefer `platform_id` and fall back to `seller_id` only when the new field is absent. Both fields remain optional, and legacy responses remain schema-valid.

Reserve `seller_id` for seller identity in new naming, while preserving the existing aliases' object-ID semantics. The aliases remain functional throughout 3.x, with removal no earlier than 4.0 and subject to the six-month deprecation notice policy. Update examples and migration guidance. Fixes #8290.
