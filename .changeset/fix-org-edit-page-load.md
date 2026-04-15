---
---

Fix organization edit page failing to load when billing API is slow. Get
is_personal from /api/me (already fetched) instead of blocking on the
heavy billing endpoint. Add 15s fetch timeouts to prevent pages hanging
indefinitely on slow API responses.
