---
---

fix(thread-service): serialize sequence-number assignment per thread + run the test that catches it

`ThreadService.addMessage` assigned `sequence_number` via
`SELECT COALESCE(MAX(sequence_number), 0) + 1 ... INSERT` inside a
`READ COMMITTED` transaction. Two concurrent `addMessage` calls on the
same thread both observe the same `MAX` and write the same next value;
the schema's `(thread_id, sequence_number)` index is non-unique, so the
collision is silent and `getThreadMessages`'s `ORDER BY sequence_number
ASC` returns a nondeterministic order between the duplicates. Affects
any path with concurrent writes to one thread: parallel Slack thread
posts, webhook bursts, fast tool-call sequences.

Fix: take `pg_advisory_xact_lock(hashtext(thread_id))` at the top of the
transaction. Same pattern as `billing/org-intake-lock`. Locks only
serialize on the same thread; cross-thread inserts run unimpeded.
Released automatically on COMMIT/ROLLBACK.

The test that caught this — `should handle concurrent addMessage calls
with correct sequence numbers` — was sitting in
`server/tests/unit/thread-service.test.ts` but the unit job doesn't set
`DATABASE_URL` and the integration job only globs
`server/tests/integration/`, so all 39 tests in the file silently
skipped in both jobs. Move resurfaces the file (and a single
`describe.skipIf(!DATABASE_URL)` stays as defense-in-depth for local
runs without a Postgres). Existing
`server/tests/integration/threads-api.test.ts` covers the HTTP layer;
this file covers the service layer. Both run now.

Follow-up (separate PR, after a production dedup audit): add a
`UNIQUE(thread_id, sequence_number)` constraint as defense-in-depth so
any future regression surfaces as a hard INSERT failure rather than
silent duplicates. Not bundled here because existing rows in production
may already have collisions from the racey code path; adding the
constraint without a dedup pass would break the migration.
