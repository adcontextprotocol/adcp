---
---

fix: resolve DB health check timeouts by switching all rate limiters to CachedPostgresStore and using a dedicated connection for health checks
