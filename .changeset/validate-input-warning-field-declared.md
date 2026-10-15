---
"adcontextprotocol": patch
---

Declare `field` on `validate_input` warning items in `creative/validate-input-result.json`. The `warnings` items already required `field` but never declared it under `properties`, so SDKs generated from the schema left it out and a warning built from a generated type failed validation. No conforming payload's validity changes. Reported by torbenbrodt (#8194).
