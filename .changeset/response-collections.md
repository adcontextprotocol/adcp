---
"adcontextprotocol": minor
---

Return full collection objects in product and proposal responses (experimental, feature id `media_buy.collection_cards`): an optional top-level `collections` array of `core/response-collection.json` entries (a collection with `publisher_domain` required) on the `get_products`, `list_products`, `request_proposals` and `refine_proposals` responses. Entries cover only collections the returned products reference, one per `(publisher_domain, collection_id)`, and appear only alongside `products`. They are convenience copies: `adagents.json` stays the authorization source and wins on authorization, while the response wins on freshness of descriptive facts. Also adds `url` to `core/collection.json`, a `collections` field and `fields` value on `get_brand_identity`, and `publisher_domain` on `brand.json` collection links, so a buyer can go from a talent's `brand_ref` to the person's channels. Refs #8137.
