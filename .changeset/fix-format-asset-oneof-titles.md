---
"adcontextprotocol": patch
---

Add `title` to all `oneOf` branches in `format.json`'s `assets[]` array so codegen tools (json-schema-to-typescript, datamodel-code-generator, oapi-codegen) produce named, discriminated per-asset-type interfaces instead of collapsing them to an untyped union. Adds titles `IndividualImageAsset` … `IndividualCatalogAsset` and `RepeatableGroupAsset` at the top level, plus `GroupImageAsset` … `GroupWebhookAsset` for the nested branches inside `repeatable_group.assets[]`. Purely annotation-level; no validation or wire-format change.
