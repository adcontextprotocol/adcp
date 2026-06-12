---
---

fix(tooling): unref background timers so vitest workers exit cleanly; raise pre-commit timeout budgets

Root-cause fix for the sporadic pre-commit vitest teardown hang (#2541), which #2542 mitigated with `--pool=threads` + a shell timeout but left the actual handles in place. Seven background `setInterval` loops were missing `.unref()` — `crawler.ts` (periodic crawl / catalog crawl / manager revalidation), `luma/sync.ts`, `addie/jobs/scheduler.ts`, and the two `scheduled/*` digest/reminder loops. When a test imports-and-triggers one, the live timer keeps the worker's event loop alive at exit and the worker zombies. These are server-internal background loops (the server stays alive via its HTTP listener, never these timers), so `.unref()` is correct in production too and matches the 12+ sibling intervals that already do it.

Also raises the pre-commit `with-timeout` budgets (`test:unit` 60→180s, `precommit:server-unit` 120→240s): the suites legitimately grew past the caps set in #2542, so under multi-workspace CPU contention they were SIGTERM'd mid-run even without a hang. The timeout stays as a generous catastrophic-hang guard rather than a normal-run tripwire.

No wire/schema/runtime-contract change.
