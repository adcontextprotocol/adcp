---
---

dashboard(verification-panel): mark each declared specialism with pass/fail/untested status and replace abstract "next heartbeat" copy with the concrete check-cycle window. The per-agent compliance card no longer requires the developer to cross-reference the storyboard track pills above to know which declared specialism is the cause of an overall `failing` status.

Per-specialism marks: ✓ (passing), ✕ with strike-through (failing), · (untested or not in catalog). Computed server-side via `computeSpecialismStatus()` so the storyboard-id mapping has one source of truth. `unknown` is returned for specialisms the catalog doesn't recognize (e.g. preview specialisms or future additions an older server hasn't learned yet).

ETA: "on the next heartbeat" → "within the next check cycle (12h)" — pulled from `agent_registry_metadata.check_interval_hours` (default 12), now flowed to the compliance detail response.

Implements stage 1 of #3525. Tier-inline (stage 2) ships separately because it touches auth/billing surfaces.
