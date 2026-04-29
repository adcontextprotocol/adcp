---
---

ops(migrate): bound migration advisory-lock acquisition with a 5-minute statement_timeout

If a prior `runMigrations()` session crashed while holding `pg_advisory_lock`, the next deploy currently waits until Postgres' TCP keepalive reaps the dead session — by default ~2 hours. With the 15-minute Fly `release_command_timeout`, that means the deploy "hangs" until manual intervention.

Now `acquireMigrationLock` sets `statement_timeout = '5min'` while waiting for the lock, then clears it once acquired (so the migration itself isn't capped). On timeout (pg code `57014`), we throw a diagnostic error that names the lock key and shows the SQL to find and terminate the wedged session.

Behavior is unchanged in the happy path: legitimate concurrent callers (release_command + a dev's docker-compose) still serialize on the blocking `pg_advisory_lock`, just with a bound on stale-session waits.
