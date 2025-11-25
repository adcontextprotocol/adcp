---
---

Simplify registry to database-only by removing file-based fallback. Production already uses the database (PR #254), so this change removes unused code and simplifies the architecture. Internal refactoring with no API or schema changes.
