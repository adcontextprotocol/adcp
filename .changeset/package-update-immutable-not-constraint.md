---
"adcontextprotocol": minor
---

Add schema-level `not` constraints to `package-update.json` that explicitly forbid immutable fields (`committed_metrics`, `committed_vendor_metrics`, `product_id`, `format_ids`, `pricing_option_id`) from appearing in update payloads. Mirrors existing MUST NOT prose with machine-checkable validation so permissive sellers can no longer silently override frozen values.
