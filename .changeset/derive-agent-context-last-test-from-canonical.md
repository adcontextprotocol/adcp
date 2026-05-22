---
"adcontextprotocol": patch
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
  When no owner-canonical row exists, the view falls back to the legacy
  `agent_contexts.last_test_*` columns so non-owner `recordTest()` results
  remain visible to saved-agent list callers.
- `AgentContextDatabase.getByOrganization`, `getById`, `getByOrgAndUrl`
  now SELECT from the view and alias `canonical_last_test_*` →
  `last_test_*` so callers see no shape change.

**Backward compat.** The legacy `agent_contexts.last_test_*` columns stay.
Third-party (non-owner) `recordTest()` writes still update them, and the
view falls back to those fields when no owner-canonical run exists — that's
the session-scoped audit trail PR 3 of #4247 retained for non-owner runs.
The columns become dead-letter once `agent_test_history` is dropped (gated
on the soak windows in #4247) and `recordTest()` retires in the follow-up
"final cleanup" PR.

**Semantic shift (last_test_scenario).** For owner test runs,
`last_test_scenario` now returns `tracks_json[0].track` (e.g.
`'quality_evaluation'`) rather than the literal string the old
`recordTest()` write path stored directly. No existing callers branch on
this value, but downstream consumers that read `last_test_scenario` should
expect a track name sourced from the canonical run record rather than the
legacy scenario string.

**Semantic shift (total_tests_run).** When an owner-canonical run exists,
`total_tests_run` now returns the count of non-dry-run canonical rows scoped
to `(triggered_org_id, agent_url)`. When no owner-canonical row exists, it
falls back to the legacy per-context counter so non-owner saved-agent tests
remain visible.

**Index.** `idx_agent_compliance_runs_triggered_org_url_at` on
`(triggered_org_id, agent_url, tested_at DESC)` (partial, only where
`triggered_org_id IS NOT NULL`) supports the view's per-org LATERAL lookup
as a single index scan.

**Stacked on** #4264 (PR 3) → #4263 (PR 2) → #4250 (PR 1).
