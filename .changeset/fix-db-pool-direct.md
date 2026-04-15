---
---

Bypass PgBouncer and connect directly to Postgres with a properly configured connection pool (max=40, min=5, 30s idle timeout). Removes PgBouncer-specific workarounds that caused double-pooling issues.
