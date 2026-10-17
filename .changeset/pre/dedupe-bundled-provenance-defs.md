---
"adcontextprotocol": patch
---

Bundled schemas (`/schemas/{version}/bundled/`) now carry `core/provenance.json` once in root `$defs.Provenance` and reference it from each call-site as `{"$ref": "#/$defs/Provenance", "description": "..."}`, instead of inlining the full body 40-80 times per bundle. Bundle output shrinks by roughly 20%. Source schemas and validation behavior are unchanged, and per-call-site descriptions are preserved. In bundles with repeated provenance, enclosing inlined schemas now lose their deep `$id` (existing behavior for subtrees containing hoisted `$defs` refs), and two `required_disclosures` description strings may differ because the enum hoist fingerprints enums without their description.
