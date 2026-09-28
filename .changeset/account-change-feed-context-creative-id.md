---
"adcontextprotocol": patch
---

compliance: thread the external creative ID in the `media_buy_seller/account_change_feed` storyboard through a `context_outputs` generator instead of a `$generate:uuid_v4#alias`. Runner aliases are phase-scoped, so the drain, repair, update, and rebootstrap phases were comparing the feed against a freshly generated UUID rather than the creative the connected platform seeded.
