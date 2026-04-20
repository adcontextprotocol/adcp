---
"adcontextprotocol": minor
---

Add optional `targeting_overlay` to the `PackageStatus` shape returned by `get_media_buys`. Sellers SHOULD echo persisted targeting from `create_media_buy` / `update_media_buy` so buyers can verify what was stored without replaying the original request, mirroring the echo pattern already used for budget, pricing, and dates. Sellers claiming the `property-lists` or `collection-lists` specialisms MUST include, within this `targeting_overlay`, the `PropertyListReference` / `CollectionListReference` they persisted. Resolves #2488.
