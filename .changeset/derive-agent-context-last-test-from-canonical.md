---
---

PR 4 of the #4247 unification stack. Replaces direct reads of
`agent_contexts.last_test_*` with a view that derives them from
`agent_compliance_runs` — the canonical source PR #4250 unified onto.

**What changes.**

- New column `agent_compliance_runs.triggered_org_id` (nullable). Populated
  by the owner-test write path in `evaluate_agent_quality` using the
  caller's `organizationId`. Heartbeat / manual / webhook writes leave it
  NULL — they don't have an org dimension. Without this column, two orgs
  that own the same agent URL (e.g. staging and prod orgs of one publisher)
  would conflate their test history through a join on `agent_url` alone.
- New view `agent_context_with_latest_test`: `agent_contexts.*` joined to
  the latest non-dry-run `agent_compliance_runs` row scoped by
  `(triggered_org_id, agent_url)` via `LEFT JOIN LATERAL`, plus a COUNT
  scalar subquery for `total_tests_run`. Surfaces the derived fields as
  `canonical_last_test_*` so the column-rename in the SELECT is explicit.
- `AgentContextDatabase.getByOrganization`, `getById`, `getByOrgAndUrl`
  now SELECT from the view and alias `canonical_last_test_*` →
  `last_test_*` so callers see no shape change.

**Backward compat.** The legacy `agent_contexts.last_test_*` columns stay.
Third-party (non-owner) `recordTest()` writes still update them — that's
the session-scoped audit trail PR 3 of #4247 retained for non-owner runs.
The columns become dead-letter once `agent_test_history` is dropped (gated
on the soak windows in #4247) and `recordTest()` retires in the follow-up
"final cleanup" PR.

**Index.** `idx_agent_compliance_runs_triggered_org_url_at` on
`(triggered_org_id, agent_url, tested_at DESC)` (partial, only where
`triggered_org_id IS NOT NULL`) supports the view's per-org `DISTINCT ON`
lookup as a single index scan.

**Stacked on** #4264 (PR 3) → #4263 (PR 2) → #4250 (PR 1).
