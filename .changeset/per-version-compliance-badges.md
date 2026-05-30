---
"adcontextprotocol": patch
---

Restore 3.0 as the default hosted compliance target and keep public badge
issuance scoped to the selected stable compliance line. Previously, the 3.1
beta default could reject 3.0-only agents or leave premature public 3.1 badges
visible; stale public 3.1 badges are now revoked until that line is GA-ready.
