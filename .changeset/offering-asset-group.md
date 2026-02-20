---
"adcontextprotocol": minor
---

Type `Offering.assets` as `OfferingAssetGroup[]`. Add `OfferingAssetGroup` schema for structured per-offering creative pools (headlines, images, videos). Add `OfferingAssetConstraint` schema and extend `PromotedOfferingsAssetRequirements` with `offering_asset_constraints` so formats can declare per-group asset requirements on offerings. Extend `PromotedOfferingsRequirement` enum with `offerings.assets` and `offerings.landing_url`.
