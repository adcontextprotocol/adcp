---
"adcontextprotocol": patch
---

Fix the governance revocation-list example on the L1 security page to the JWS flattened JSON serialization the prose (and the reference training agent) use: top-level `protected`, `payload`, and `signature`, instead of the General serialization's `signatures[]` array a flattened-only verifier would reject.
