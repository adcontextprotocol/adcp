---
---

Convert the 16 remaining static `idempotency_key` literals across error, governance,
measurement, signal, and schema-validation storyboard scenarios to
`$generate:uuid_v4#<alias>` form. Closes the static-key sweep started in #4218 / #4232
so storyboard re-runs against any spec-compliant seller no longer collide with the
seller's idempotency cache after deploys. Closes #4344.
