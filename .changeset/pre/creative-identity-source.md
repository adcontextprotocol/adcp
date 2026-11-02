---
"adcontextprotocol": minor
---

Stable IDs for creatives created outside AdCP. `list_creatives` already lists creatives that entered the seller's library outside `sync_creatives`, for example before a buyer connected to an advertiser with live buys. The seller assigns their `creative_id`, and buyers use it to reference them later.

- New capability `creative.stable_creative_ids` (requires `has_creative_library: true`). A seller that declares it MUST keep seller-assigned creative IDs stable for the creative's lifetime and unique within the account, MUST NOT reuse a buyer's `creative_id`, and under `sync_creatives` `delete_missing` MUST NOT archive seller-created creatives. Without it, sellers SHOULD follow the same rules, buyers MUST NOT rely on them, and `delete_missing` keeps its 3.2 behavior.
- `list_creatives` `creatives[].platform_id` returns the seller's own identifier, previously only on the `sync_creatives` response, so operators can match a creative to the seller's UI and reports. Buyers still address creatives by `creative_id`.
- A sync of an existing `creative_id` updates that creative under the normal upsert rules, whatever created it. Buyers SHOULD use UUIDs or a stable prefix for their IDs and detect collisions from `action: updated` where they expected `created`.

Opt-in and additive: 3.2 sellers stay conformant, and 3.2 payloads stay valid.
