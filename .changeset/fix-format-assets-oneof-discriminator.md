---
"adcontextprotocol": patch
---

Restructure `core/format.json` `assets[].items` from a flat 16-variant `oneOf` to a two-tier discriminated union: outer discriminator on `item_type` (`individual` | `repeatable_group`), inner discriminator on `asset_type` across the 15 individual asset variants. Wire payload set is unchanged; Ajv `discriminator` mode (requires `{ discriminator: true }` initialization) now routes correctly without scanning all variants.

**Codegen note:** Consumers auto-generating SDK types (quicktype, ts-json-schema-generator, etc.) will see a new intermediate `IndividualAsset` wrapper type on regeneration. The wire contract is unchanged; regenerate and verify call sites.

**Discriminator semantics:** The `discriminator` keyword is an OAS 3.x / Ajv extension and is advisory for standard JSON Schema draft-07 validators. Standard validators continue to use full `oneOf` evaluation; only validators initialized with discriminator support benefit from the routing optimization.
