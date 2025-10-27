---
"adcontextprotocol": minor
---

Remove media buy level budget field. Budget is now only specified at the package level, with each package's pricing_option_id determining the currency. This simplifies the protocol by eliminating redundant budget aggregation and allows mixed-currency campaigns when sellers support it.

**Breaking changes:**
- Removed `budget` field from create_media_buy request (at media buy level)
- Removed `budget` field from update_media_buy request (at media buy level)

**Migration:**
- Move budget amounts to individual packages
- Each package specifies budget as a number in the currency of its pricing_option_id
- Sellers can enforce single-currency rules if needed by validating pricing options
