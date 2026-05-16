---
---

Initialize the database pool in `backfill-primary-brand-domain.ts` (matches the convention of other prod-runnable scripts in `server/src/scripts/`). Without this, the script crashed on first `getPool()` call.
