---
"adcontextprotocol": minor
---

Restructure `Format.assets[]` oneOf from a flat 16-variant union to a two-tier discriminated union. Outer discriminator on `item_type` ("individual" | "repeatable_group"); inner discriminator on `asset_type` for the 15 individual-asset variants. Adds `discriminator.propertyName` hints at both tiers and direct `required` constraints on each variant so codegen tools (openapi-generator, quicktype) produce proper discriminated-union types. Wire-payload acceptance set is unchanged.
