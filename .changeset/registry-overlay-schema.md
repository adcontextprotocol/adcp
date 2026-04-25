---
---

Add empty schema for the property registry overlay model: `publishers` table (one row per domain, caches `adagents.json` body as JSONB) and `publisher_authorization_overrides` (per-agent corrections with `bad_actor` / `correction` / `file_broken` reasons, lifecycle differs by reason). Mirrors the brand registry pattern. No backfill, no readers/writers yet — those land in subsequent PRs.

Tracking: #3177.
