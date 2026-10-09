---
"adcontextprotocol": minor
---

Add experimental `Product.property_coverage.disclosure` (`complete | partial | undisclosed`, feature id `media_buy.property_coverage`) so network and run-of-network products can declare whether `publisher_properties[]` is an exhaustive coverage boundary. Absence means `complete`. Mirrored on `canonical-product` and the `list_products` field projection, which returns the disclosure whenever a partial or undisclosed roster is returned.

SDK type change: `publisher_properties` stays required but loses its unconditional `minItems: 1`, so generated types change for every product, including `complete` ones (a TypeScript non-empty tuple becomes `T[]`; a Pydantic `min_length` is dropped). `[]` is valid only with `disclosure: "undisclosed"`, which cannot offer inclusion targeting. Consumers must not index `publisher_properties[0]` unguarded and must check `disclosure` before treating the list as a delivery boundary; an empty array under `undisclosed` is an unknown roster, not an empty set. `partial` lists are explicitly not delivery-containment guarantees.

On request-bound discovery, sellers emit partial or undisclosed products only to buyers pinning `adcp_version` 3.3 or later. Adds cross-SDK vectors under `static/test-vectors/product/`.
