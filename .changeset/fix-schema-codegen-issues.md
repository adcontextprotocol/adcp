---
"adcontextprotocol": patch
---

Fix forbidden-field `not: {}` pattern in response schemas and document `deliver_to` breaking change.

Remove `"not": {}` property-level constraints from 7 response schemas (creative and content-standards). These markers were intended to mark fields as forbidden in discriminated union variants, but caused Python code generators to emit `Any | None` instead of omitting the field. The `oneOf` + `required` constraints already provide correct discrimination; the property-level `not: {}` entries are redundant.

Add migration guide to release notes for the `get_signals` `deliver_to` restructuring: the nested `deliver_to.deployments` object was replaced by top-level `destinations` and `countries` fields.
