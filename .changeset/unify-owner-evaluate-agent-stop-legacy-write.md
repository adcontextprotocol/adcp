---
---

PR 3 of the #4247 unification stack. Two coupled changes:

**Backfill historical owner-triggered tests into the canonical compliance
tables.** Migration `472_backfill_agent_test_history_to_compliance_runs.sql`
copies every `agent_test_history` row with a `user_id` into
`agent_compliance_runs` as `triggered_by = 'owner_test'` (carrying the
source row id in `observations_json.backfill_source_id` so a re-run is a
no-op via `WHERE NOT EXISTS`). Each agent's most-recent backfilled row
also upserts into `agent_compliance_status` so the dashboard's compliance
tile immediately reflects a real verdict for any agent that was tested
through Addie pre-PR-#4250 and never ran the heartbeat.

**Stop the dual write for owner runs.** `evaluate_agent_quality` no longer
calls `agentContextDb.recordTest()` when the caller owns the agent — that
path was the dual-write bug #4247 is closing. The legacy `recordTest` call
is retained ONLY for third-party runs so a stranger who tests someone
else's agent still has a session-scoped audit trail in their own
`agent_test_history`. Owner-triggered runs persist exclusively to
canonical state going forward.

**Out of scope** (deferred to a follow-up after the soak gates):

- Drop `agent_test_history` table — gated on the 14-day soak from #4250
  deploy + 7-day soak from #4263 + S3 cold-storage export of the
  remaining (`user_id IS NULL`) third-party rows. Migration 472 documents
  this in its trailing comment.
- Collapse `agent_contexts.last_test_*` into a derived view — PR 4 of
  the #4247 stack.

**Stacked on** #4263 (PR 2 of #4247) → #4250 (PR 1 of #4247).
