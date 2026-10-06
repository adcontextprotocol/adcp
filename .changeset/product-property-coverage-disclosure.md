---
"adcontextprotocol": minor
---

Add optional `Product.property_coverage.disclosure` (`complete | partial | undisclosed`) so network and run-of-network products can declare whether `publisher_properties[]` is an exhaustive coverage boundary. Absence means `complete`. `publisher_properties` stays required but may be empty only for `undisclosed`, which cannot offer inclusion targeting; `partial` lists are explicitly not delivery-containment guarantees. Mirrored on `canonical-product` and the `list_products` field projection (disclosure is returned whenever a partial or undisclosed roster is). Sellers emit partial/undisclosed products only to buyers pinning `adcp_version` 3.3 or later. Adds cross-SDK vectors under `static/test-vectors/product/`.
