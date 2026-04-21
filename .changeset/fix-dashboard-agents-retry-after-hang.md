---
---

fix(dashboard-agents): cap Retry-After wait so the page never hangs on "Loading agents..."

`fetchWithRetry` blindly honored the server's `Retry-After` header on 429
responses. `bulkResolveRateLimiter` (used by every per-agent compliance
endpoint) sits on a 60s window via `standardHeaders`, so under load the
header could tell the browser to sleep for nearly a minute. That sleep
blocked `Promise.allSettled` inside `loadAgents()`, which meant
`renderPage()` never ran and `#hub-loading` stayed visible indefinitely.

Cap the Retry-After wait at 3s; past that, return the 429 to the caller so
the per-agent "Rate-limited — Retry" card renders (that branch already
exists). Also wrap the fan-out in a 15s timeout race so any future fetch
hang still falls through to per-card states instead of pinning the page on
the loading spinner.
