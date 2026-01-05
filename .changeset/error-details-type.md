---
"adcontextprotocol": patch
---

Add explicit type definition to error.json details property

The `details` property in core/error.json now explicitly declares `"type": "object"` and `"additionalProperties": true`, consistent with other error details definitions in the codebase. This addresses issue #343 where the data type was unspecified.
