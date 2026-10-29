---
"adcontextprotocol": patch
---

Bound the experimental `signals.delivery_methods` capability list at 20 entries, so the capabilities structural-bounds guard (#8198) holds for a field added in 3.3. The pinned worst-case capabilities figure moves to 91,261,876 bytes.
