---
"adcontextprotocol": patch
---

Convert the 12 remaining static `idempotency_key` literals across error, governance,
signal, schema-validation, and creative-ad-server storyboard scenarios to
`$generate:uuid_v4#<alias>` form. Closes the static-key sweep for the 3.0.x line so
storyboard re-runs against any spec-compliant seller no longer collide with the
seller's idempotency cache after deploys. 3.0.x port of #4231; closes #4344 on the
patch line.
