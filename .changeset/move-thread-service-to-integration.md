---
---

chore(tests): move thread-service.test.ts from unit to integration

`server/tests/unit/thread-service.test.ts` was misfiled — its own header
described the tests as integration tests requiring a running Postgres,
and it was guarded with `describe.skipIf(!process.env.DATABASE_URL)`.
The unit job doesn't set `DATABASE_URL`, and the integration job globs
only `server/tests/integration/`, so all 39 tests skipped in both jobs
and ran nowhere.

Surfaced while auditing the actual coverage of #3094's CI fix (#3292):
60 integration files now run, 1 file skipped (`creative-agent-comparison`,
gated on `COMPARE_LIVE=1` — intentional). The thread-service file was the
one quiet anomaly that #3094's audit didn't catch because the file lives
in `unit/`, not `integration/`.

The fix is a `git mv` plus a header refresh. The `describe.skipIf` stays
as defense-in-depth so a developer running this file outside the
integration job without `DATABASE_URL` set sees a clean skip instead of
a connection error.

Existing `server/tests/integration/threads-api.test.ts` covers the HTTP
API layer; this file covers the service layer. Both run now.
