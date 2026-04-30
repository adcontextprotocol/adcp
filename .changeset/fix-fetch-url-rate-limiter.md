---
---

Add rate limiter to `POST /api/content/fetch-url` (URL metadata auto-fill endpoint). The endpoint was previously unbounded: each call allocates a new `undici.Agent` and makes an outbound HTTP request, making it a resource-exhaustion path for authenticated users. Limit set to 30 requests per 15 minutes per user via `PostgresStore` (synchronous DB write, enforced consistently across all pods). Non-breaking: under-limit requests are unaffected.

Follow-up tracked: `response.text()` at the call site buffers the full response body with no size cap — a separate concern not introduced here.
