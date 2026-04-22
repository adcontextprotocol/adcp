---
---

Addie tool rate limiter (#2789): move per-user, per-tool, and workspace counters from an in-process `Map` to Postgres so caps are bounded across multi-instance Fly deploys. Before: a user fanned across N pods got N× the advertised global 200/10min cap. After: counters are shared via a new `addie_tool_rate_limit_events` table. Preserves exact sliding-window semantics. Tests swap an in-memory store via a DI seam so they stay unit-level (no DB required). Also closes #2733 (content propose rate limit — already shipped in #2767).
