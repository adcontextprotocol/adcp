---
"adcontextprotocol": patch
---

Promote the shared asset-variant `oneOf` union to a canonical `core/assets/asset-union.json` schema. Both `creative-asset.json` and `creative-manifest.json` now reference this single file instead of inlining identical `oneOf` arrays. This eliminates the `VASTAsset1`, `DAASTAsset1`, `BriefAsset1`, and `CatalogAsset1` codegen artifacts emitted by `json-schema-to-typescript` when the same union is encountered through multiple parent schemas. Wire format and validation semantics are unchanged.
