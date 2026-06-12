---
"adcontextprotocol": patch
---

Fix storyboard `field_value_or_absent(status, MediaBuyStatus)` checks that created impossible-to-satisfy constraints alongside `response_schema`.

`protocol-envelope.json` has `required: ["status"]` typed as the TaskStatus enum. Three storyboard checks across `pending_creatives_to_start.yaml` and `available_actions.yaml` were asserting MediaBuyStatus values ("pending_creatives", "pending_start"/"active", "active") at the envelope `status` key — leaving no valid response shape that could satisfy both `response_schema` and the field assertion. Replaced with `field_value(status, "completed")` matching what protocol-envelope mandates for synchronous success. Also updated two stale narrative prose references from "status: pending_creatives" to "media_buy_status: pending_creatives".

Fixes #5416.
