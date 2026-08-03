---
"adcontextprotocol": patch
---

Restructure `core/format.json` `assets[].items` from a flat 16-variant `oneOf` to a two-tier discriminated union: outer discriminator on `item_type` (`individual` | `repeatable_group`), inner discriminator on `asset_type` across the 15 individual asset variants. Wire payload set is unchanged; Ajv `discriminator` mode now routes correctly without scanning all variants.
