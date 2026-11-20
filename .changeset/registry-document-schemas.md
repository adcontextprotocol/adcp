---
"adcontextprotocol": patch
---

Give the four registry documents a schema for their own data: `core/asset-group-vocabulary.json`, `core/format-shape-vocabulary.json`, `creative/asset-types/index.json`, and `extensions/index.json` (source and generated). Each declared `$schema` but stated no keyword, so each was the empty schema and admitted every JSON value. Each now states `type: object` and the shape of its entries, and validates against itself. No URL changes. (#9104)
