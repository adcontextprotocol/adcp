---
"adcontextprotocol": patch
---

Simplify registry to database-only by removing file-based fallback. Production already uses the database (PR #254), so this change removes unused code and simplifies the architecture. No breaking changes for existing deployments as they already use the database.
