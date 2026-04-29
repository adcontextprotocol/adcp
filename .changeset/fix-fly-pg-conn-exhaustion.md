---
---

fix(server): stop running migrations on every machine boot, lower default pg pool size

Fly rolling deploys were exhausting Postgres connection slots (53300, "remaining connection slots are reserved for roles with the SUPERUSER attribute"). Two contributors:

1. `HTTPServer.start` called `runMigrations()` unconditionally on every boot, even though `fly.toml`'s `release_command` already runs migrations once before the deploy. With dozens of machines all booting in parallel, each one grabbed a pool client just to read `schema_migrations` and crashed when slots ran out. Removed; migrations now run only via the release command in prod and `RUN_MIGRATIONS=true` for local/docker.
2. Default pg pool sized at `max=20, min=5` per machine. With many machines that idles 5×N connections and bursts to 20×N. Lowered defaults to `max=8, min=0`. Override per environment with `DATABASE_POOL_MAX` / `DATABASE_POOL_MIN`.
3. `runMigrations()` now wraps the run in a session-scoped `pg_advisory_lock`, so any concurrent caller (release_command + a stray app boot, two devs locally) blocks until the holder finishes instead of racing on `schema_migrations` or partially applying the same migration twice.
