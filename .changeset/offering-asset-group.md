---
"adcontextprotocol": minor
---

Refactor `PromotedOfferings` to use a unified `catalog` field. Replace separate `offerings[]` and `product_selectors` fields with a typed `Catalog` object that supports inline items, external URL references, and platform-synced product catalogs through a single interface. Add `OfferingAssetGroup` schema for structured per-offering creative pools, `OfferingAssetConstraint` for format-level asset requirements, and `geo_targets` on `Offering` for location-specific offerings.
