---
"adcontextprotocol": patch
---

Emitting `mutation_outcome: "unknown"` (or `applied` with committed evidence) on a fenced idempotency claim becomes a MUST in 4.0, not 3.4: there is no 3.4 release, and 3.3 is the last 3.x minor. It stays a SHOULD for sellers declaring 3.3. The error-handling and security pages now say 4.0.
