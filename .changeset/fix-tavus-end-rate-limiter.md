---
---

fix(addie): add per-user rate limiter to POST /api/addie/video/session/:conversationName/end

The end-session endpoint was missing the `endRateLimiter` that guards the adjacent
session-creation endpoint. Adds a 10 req/min per-user cap (IP fallback) using the same
`CachedPostgresStore` pattern as `sessionRateLimiter`. Closes #3946.
