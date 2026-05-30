---
"adcontextprotocol": patch
---

Fix the training-agent `get_products` handler to reject non-string `brief` values with a structured `INVALID_REQUEST` instead of throwing on `toLowerCase()`.
