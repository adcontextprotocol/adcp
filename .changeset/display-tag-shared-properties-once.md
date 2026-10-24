---
"adcontextprotocol": patch
---

Schema: `display_tag` declares `macro_declarations`, `provenance`, `width`, `height`, and `sizes` once on the base object. Each `delivery_type` branch now only narrows `macro_declarations[].location.field` to its own fields, the same way `vast` and `daast` already do. The set of valid assets is unchanged. When every `$ref` is written out in full, the asset drops from ~280 KB to ~74 KB (#8374).
