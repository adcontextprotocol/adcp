---
---

fix(server): raise storyboard eval/step rate limits for member dev iteration (closes #3277)

Bumps `storyboardEvalRateLimiter` from 5→10/hr and `storyboardStepRateLimiter` from 30→60/hr so
members can complete a typical 4–5 cycle debug session without hitting the wall. Admin bypass
added in #2729 is unchanged. Also fixes both handlers to use the real `Retry-After` window
position instead of a hardcoded full-hour fallback — matching the pattern already used by
`agentReadRateLimiter` in the same file.

Non-protocol server change; no schema or task-definition impact.
