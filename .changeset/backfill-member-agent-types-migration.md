---
---

Convert the stale-`type` backfill (#3541) from a manual ops script into migration `463_backfill_member_agent_types_from_snapshot.sql`. The TS script lived outside `server/src/` so `tsc` skipped it and the file never shipped to the production container — running it required a `fly ssh console` dance that silently failed with `ERR_MODULE_NOT_FOUND`. The migration applies the same `resolveAgentTypes()` logic in SQL, runs automatically on the next deploy in every env, and writes its audit trail to `type_reclassification_log` with `run_id='migration-463'` in one transaction. Removes `server/scripts/backfill-member-agent-types.ts`.
