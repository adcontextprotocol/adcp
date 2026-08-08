---
"adcontextprotocol": minor
---

Require AdCP 3.2 producers to emit integer `error.retry_after` seconds while preserving the released numeric wire type for 3.x compatibility, and define ceiling-before-clamp behavior for clients that encounter legacy fractional values.
