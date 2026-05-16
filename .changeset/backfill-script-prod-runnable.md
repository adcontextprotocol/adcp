---
---

Move `backfill-primary-brand-domain.ts` to `server/src/scripts/` so it ships in `dist/scripts/` and is runnable on prod via `fly ssh`. Default to dry-run (require explicit `--apply` to write). Add a personal-org test pinning that brand-identity auto-populate is intentionally not gated on `is_personal`.
