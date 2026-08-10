---
"adcontextprotocol": major
---

Require idempotency keys in AdCP 4.0 for polymorphic `get_products` requests so asynchronous discovery and proposal finalization are safe to retry. AdCP 3.x retains its bounded omission grace only for guaranteed side-effect-free synchronous reads.
