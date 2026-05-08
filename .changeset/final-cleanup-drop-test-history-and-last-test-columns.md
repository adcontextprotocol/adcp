---
---

Final cleanup of the #4247 compliance-state unification stack. Drops
`agent_test_history` and the `agent_contexts.last_test_*` columns now
that owner test runs persist canonically via
`agent_compliance_runs.triggered_by='owner_test'` (PR #4250) and
read-side derivation goes through `agent_context_with_latest_test`
(PR #4268).

**Pre-merge gate (load-bearing — destructive migration):**

1. PR #4250 ≥ 14 days live in prod with zero canonical-write incidents.
2. PR #4263 ≥ 7 days live in prod with the dashboard rendering identical
   verdicts via the view-derived path.
3. PR #4264's migration 472 has run; row-count delta on staging is ±0
   (every owner-triggered `agent_test_history` row backfilled into
   `agent_compliance_runs`).
4. Third-party (`user_id IS NULL`) rows from `agent_test_history`
   exported to S3 cold storage. Export evidence committed to the ops
   runbook before the migration runs. Reversibility path is the export,
   not pg_dump.
5. PR #4268's view + reader migration confirmed working in prod.

**What this PR does.**

- **Migration 474.** Redefines `agent_context_summary` view without
  references to the dropped table/columns; drops
  `agent_contexts.last_test_*` columns; drops `agent_test_history`
  table; refreshes `agent_context_with_latest_test` so the view's
  `ac.*` projection no longer carries the removed columns.
- **`agent-context-db.ts`.** Removes `recordTest`, `getTestHistory`,
  `getLatestTestForUser`, the `AgentTestHistory` interface, and the
  `RecordTestInput` interface. The `last_test_*` SET branches in
  `update()` go away; the method now refetches via `getById()` after
  the UPDATE so derived view fields stay populated.
- **`evaluate_agent_quality`.** The third-party `recordTest()` write
  path is removed. Non-owner runs are now session-scoped — they return
  results in the response and do not persist.
- **`run_storyboard`.** The `recordTest()` write path is removed.
  Single-storyboard runs remain session-scoped (they don't write
  canonical state because that would over-state the test coverage of
  a single storyboard). A future `triggered_by = 'storyboard_test'`
  enum value would expand canonical writes here, but that's a separate
  design discussion.

**Behavior change.**

- Third-party / non-owner `evaluate_agent_quality` runs against
  someone else's agent no longer leave any persistent state in the
  registry. Matches the "owner-only canonical writes" policy from
  #4247. Stranger-runs return results to the caller in the same
  shape; they just don't persist.
- `run_storyboard` runs (any caller) no longer leave persistent state
  in the registry. The dashboard's "tested at" timestamps for an org
  reflect only `evaluate_agent_quality` runs (which exercise the full
  comply suite); single-storyboard runs are exploratory tooling.

**Stacked on** #4268 (PR 4) → #4264 (PR 3) → #4263 (PR 2) → #4250 (PR 1).
