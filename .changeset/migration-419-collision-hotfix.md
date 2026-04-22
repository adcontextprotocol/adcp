---
---

hotfix: rename `419_oauth_client_credentials.sql` → `420_oauth_client_credentials.sql`

Main landed two migrations numbered 419 — [#2793](https://github.com/adcontextprotocol/adcp/pull/2793) (agent visibility, merged first) and [#2800](https://github.com/adcontextprotocol/adcp/pull/2800) (OAuth client-credentials persistence, merged second). The per-PR "No duplicate migration numbers" CI check passed on each individually because at check-time the other 419 wasn't on main yet. A merge-queue race.

Symptom: every fresh DB boot now fails with `Migration filename validation failed: Duplicate migration version 419`. Every already-deployed instance will fail on its next restart because it'll see two 419s on disk.

## Fix

Rename `419_oauth_client_credentials.sql` → `420_oauth_client_credentials.sql` (the migration that landed second). Pure filename change, no SQL modification. The ALTER TABLE statements use `ADD COLUMN IF NOT EXISTS`, so the migration is idempotent:

- **Fresh DBs** will apply 419 (visibility) and 420 (oauth_cc) in order.
- **Instances that already ran the original 419 (oauth_cc)**: `schema_migrations` has version=419, filename='419_oauth_client_credentials.sql'. The filename-mismatch guard at `migrate.ts:178-199` would normally throw on this, but since we also rename the file on disk, the loader sees 419→agent_visibility on disk matches what the DB is about to apply. Version 420 (oauth_cc) gets applied as "new" — the `IF NOT EXISTS` columns no-op, the view recreation is a DROP+CREATE that reruns harmlessly. Done.
- **Instances that already ran #2793's 419 (visibility)**: Same outcome. Version 420 gets applied fresh, adds the oauth_cc columns. Clean.

## Test plan

- [x] `npm run typecheck` clean
- [x] Migration filename validation no longer throws (verified locally: `docker compose up` now proceeds past the load step)
- [x] `npm run test:server-unit` — full server unit suite passes
- [ ] Verify on a fresh Postgres that both migrations apply cleanly (CI's "Built migrations against Postgres" job does this automatically)

## Follow-up

The CI "No duplicate migration numbers" check should run on the merge queue's post-merge state, not pre-merge. Filing [#2812](https://github.com/adcontextprotocol/adcp/issues/2812) to track that.
