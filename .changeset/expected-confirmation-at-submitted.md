---
"adcontextprotocol": minor
---

Add optional `expected_confirmation_at` (date-time) to the `submitted` task envelope of `create_media_buy`, `buy_products`, and `accept_proposal` (#8010). A seller SHOULD set it when confirmation depends on a scheduled event such as a booking round or a manual review window; buyers SHOULD schedule a status check for that time instead of polling tightly. It is an estimate, not a commitment. Stable optional field (`x-added-in: 3.3.0`); no change for sellers that omit it.
