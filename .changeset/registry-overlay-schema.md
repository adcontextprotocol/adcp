---
---

Add empty schema for the property registry overlay model: `publishers` table (one row per domain, caches `adagents.json` body as JSONB) and `adagents_authorization_overrides` (per-agent corrections with `bad_actor` / `correction` / `file_broken` reasons, lifecycle differs by reason). Mirrors the brand registry pattern. Schema invariants enforce the design rules — bad_actor overrides cannot be silently expired, supersession reasons must match override reasons, active-set uniqueness via partial index. No backfill, no readers/writers yet — those land in subsequent PRs.

Tracking: #3177.
