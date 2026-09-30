---
"adcontextprotocol": minor
---

schema(media-buy): close canonical Product gaps on the compact lifecycle. `core/canonical-product.json` (returned by `list_products` and the proposal lifecycle) gains:

- `targeting_resolution` (`core/product-targeting-resolution.json`), so a seller that modifies `criteria.targeting_overlay` can disclose the change through `Product.targeting_resolution.modifications` as the discovery criteria and `request_proposals` response already direct. It was added only to the legacy Product in the targeting-aware discovery work that followed the canonical Product's introduction. A canonical product carrying `targeting_resolution` MUST carry `expires_at`.
- `collections` (explicit `collection_ids` selectors) and `collection_targeting_allowed` (default `false`), so a compact buyer can see a product's collections and build a `selected`-mode `collection_selection` on `buy_products`. As on the legacy Product, `overlay_support.collection_list` requires `collection_targeting_allowed: true`.

`core/canonical-reporting-capabilities.json` gains the optional `reporting_delivery_offering_ids`, with the legacy semantics (an empty array declares no managed offering; absence means unknown and MUST NOT be inferred from the seller-wide list), so `reporting-delivery-config.json` applicability can be proven from compact products.

`media-buy/product-fields.json` adds `targeting_resolution`, `collections`, and `collection_targeting_allowed`, and states that `targeting_resolution` and `expires_at` are returned whenever the seller returns modifications, and `collection_targeting_allowed` whenever returned `overlay_support` declares `collection_list`, regardless of `fields`. `get_products` accepts the same names as before.

Per-product `audience_activation` with an `audience_activation_methods` offer filter, and canonical `installments`, are deferred to 3.3 and documented in Known Limitations.
