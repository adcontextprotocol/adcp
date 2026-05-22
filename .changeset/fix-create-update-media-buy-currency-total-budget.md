---
"adcontextprotocol": minor
---

Add optional `currency` and `total_budget` fields to `CreateMediaBuySuccess` and `UpdateMediaBuySuccess` response schemas to match the entity shape already required by `get_media_buys`. Sellers using a shared mapper across create/list will now have these fields declared in the create and update schemas, eliminating silent Zod validation failures on `get_media_buys` poll steps.
