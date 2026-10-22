---
"adcontextprotocol": patch
---

Declare `field` on `validate_input` warning items in `creative/validate-input-result.json` as a string, and clarify the `warnings` description. The `warnings` items already required `field` but never declared it under `properties`, so SDKs generated from the schema left it out and a warning built from a generated type failed validation. This tightens validation: a warning whose `field` is not a string (a number, null, array or object), which the schema previously accepted, now fails. Ships on the 3.3 line only. Reported by torbenbrodt (#8194).
