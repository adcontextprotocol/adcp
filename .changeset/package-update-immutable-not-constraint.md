---
"adcontextprotocol": minor
---

Add schema-level `not` constraints to `package-update.json` that explicitly
forbid the fully-immutable fields (`product_id`, `format_ids`,
`pricing_option_id`) from appearing in update payloads. Mirrors existing
MUST NOT prose with machine-checkable validation so permissive sellers
can no longer silently override frozen values.

`committed_metrics` is intentionally NOT in the not-list. Per the unified
metric-accountability design (#3576), `committed_metrics` is **append-only**
on update — sellers accept new entries (mid-flight metric additions) but
MUST reject modify/remove of existing entries via runtime validation
(`validation_error` with code `IMMUTABLE_FIELD`). The "you can append but
not modify" semantics are not expressible in JSON Schema's `not` clause,
so this is enforced at the seller's runtime layer rather than the schema
layer. The append-only contract is documented on `committed_metrics`
itself.

Closes #3520.
