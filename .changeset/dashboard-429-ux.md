---
---

Close #2804: the Agents dashboard's 429 UX was vague and self-DOS-prone. Three fixes:

- **Concurrency cap** in `loadAgents` — replaces `Promise.allSettled(agents.map(...))` with a 6-worker pool, so a member with a large saved-agent list can't self-429 on page load. Typical users (≤10 agents) still feel instant. Workers drain a shared queue; any results that arrived before the 15s timeout are harvested into the compliance map.
- **Live countdown + single auto-retry** on rate-limited cards. Instead of "Retry in a moment" (vague, no recovery path), the card shows "Rate-limited — retry in 28s…" with a per-second countdown, disables the Retry button until zero, then auto-retries once. A second 429 on the same agent freezes the card with "You've refreshed too quickly — wait a minute before trying again." No infinite-retry loops.
- **Proxy-stripped fallback.** `agentReadRateLimiter` now emits `retryAfter` (seconds) in the 429 JSON body alongside the standard `Retry-After` header, and the client reads the body as a fallback. Reverse proxies that drop non-standard headers no longer hide the retry hint.

No test changes — the dashboard client lives in `server/public/*.html` and the repo has no frontend unit-test harness; server-side change is a small addition to an existing 429 handler.
