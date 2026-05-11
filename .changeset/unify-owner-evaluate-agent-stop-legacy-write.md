---
---

PR 3 of the #4247 unification stack. Two coupled changes:

**Stop the dual write for owner runs.** `evaluate_agent_quality` no longer
calls `agentContextDb.recordTest()` when the caller owns the agent — that
path was the dual-write bug #4247 is closing. The legacy `recordTest` call
is retained ONLY for third-party runs so a stranger who tests someone
else's agent still has a session-scoped audit trail in their own
`agent_test_history`. Owner-triggered runs persist exclusively to canonical
state via PR #4250's runtime path going forward.

**Operator-runnable backfill script for historical owner-triggered rows.**
`server/src/scripts/backfill-owner-test-history.ts` copies every
`agent_test_history` row with a `user_id` into `agent_compliance_runs` as
`triggered_by = 'owner_test'`. NOT a migration — backfilling a prod-sized
`agent_test_history` from a release-command DDL would hold locks the whole
time and is a single point of failure. The script ships in
`server/src/scripts/` per the repo's prod-runnable convention.

Script properties:

- **Chunked** by primary-key id ascending, default 1000 rows per chunk, 100ms
  sleep between chunks. Each chunk is its own short transaction so heartbeat
  and runtime writes never wait on a long-running lock. Tune via
  `--chunk-size N` / `--sleep-ms N` for prod-sized tables.
- **Cutover guard**: skips any `agent_test_history` row whose `started_at`
  is at or after the earliest `triggered_by='owner_test'` row in
  `agent_compliance_runs`. That cutover point is the live-write boundary —
  rows after it would already have been written by PR #4250's runtime path.
  Without the guard, owner runs inside the
  PR-#4250-deployed-but-script-not-yet-run window would be inserted twice.
  Fresh deploys with no canonical `owner_test` rows yet treat the cutover
  as `+infinity` and backfill all eligible rows.
- **Idempotent**: each inserted row carries `observations_json.backfill_source_id`
  pointing back to the source `agent_test_history.id`; re-runs use
  `WHERE NOT EXISTS` against that field. A partial run resumes cleanly.
- **Does NOT touch `agent_compliance_status`**. The runtime canonical write
  path maintains the current-status row; backfilling historical history rows
  shouldn't retroactively change "current" status. Resolves the
  contract-drift concern with PR #4250's `compliance-db-last-write-wins`
  test — the script's only writes go to the history table, leaving the
  status table's last-write-wins runtime contract intact.
- **Dry-run** via `--dry-run` counts eligible rows per chunk without writing.

**Out of scope** (deferred to a follow-up after PR #4264 lands):

- Drop `agent_test_history` table — gated on S3 cold-storage export of the
  remaining (`user_id IS NULL`) third-party rows.
- Collapse `agent_contexts.last_test_*` into a derived view — PR 4 of
  the #4247 stack (#4268).

**Stacked on** #4263 (merged) → #4250 (merged).
