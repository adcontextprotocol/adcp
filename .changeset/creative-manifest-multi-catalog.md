---
"adcontextprotocol": major
---

**BREAKING**: Rename `catalog` to `catalogs` (array) on creative manifest. Formats can declare multiple catalog_requirements (e.g., product + inventory + store); the manifest now supports multiple catalogs to match. Each catalog's `type` maps to the corresponding catalog_requirements entry.
