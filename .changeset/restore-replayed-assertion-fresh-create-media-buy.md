---
---

Restore positive `replayed` assertion on the fresh-path `create_media_buy_initial` step in `universal/idempotency.yaml`, now using the `field_value_or_absent` matcher (documented in #3032, shipped in `@adcp/client` 5.16.0). Fresh execution MAY omit `replayed` per `protocol-envelope.json`, but if present it MUST be `false` — this closes the coverage gap opened in #3013 without penalizing spec-correct agents that omit the field.
