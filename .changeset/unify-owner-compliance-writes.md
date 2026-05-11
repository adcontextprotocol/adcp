---
---

PR 1 of 4 in the compliance-state unification initiative (issue #4247): owner-triggered `evaluate_agent_quality` runs now write to canonical compliance tables (`agent_compliance_status`, `agent_compliance_runs`, `agent_storyboard_status`) with `triggered_by = 'owner_test'`, closing the 12-hour gap between owner tests and the public `/api/registry/agents/:url/compliance` endpoint.

`triggered_by` is retained internally as audit metadata on `agent_compliance_runs` but NOT exposed on the public registry response: heartbeat and owner_test both call `comply()` against the same registered URL with the same owner-saved credentials, so the verdict's truth content is identical regardless of who pulled the trigger. Surfacing a `verdict_source` distinction to buyers would create a trust gap the underlying observation doesn't actually carry. Internal dashboards (Emma's #4263) still show triggered_by as a UX cue.

Drops the legacy `recordComplianceRun(... 'manual')` write in `evaluate_agent_quality`. That path was gated only on `agent_contexts` row existence — which `save_agent` lets any org create for any URL without an ownership check — so a non-owner could publish a `'manual'`-tagged verdict on someone else's agent. The owner-test branch added by this PR covers the dashboard-freshness use case with a real ownership check (`member_profiles.agents` JOIN `organization_memberships`); the legacy write has no remaining function for owners and was a public-trust hole for non-owners. Legacy `agent_test_history` write is retained as session-scoped audit until Emma's #4247 PR 3 backfills + drops.

The dashboard "Run this storyboard" endpoint (`POST /api/registry/agents/:url/storyboard/:id/run`) is owner-only and now also writes `triggered_by = 'owner_test'` instead of `'manual'`, consistent with the new semantics.

Adds rate limit on `evaluate_agent_quality` via the existing Addie tool rate limiter (default 60/10min). `comply()` itself takes 10-60s per run, so this is a hard ceiling above the natural one — bounds a runaway loop, not real owner use.

Migration 475 (renumbered from 472 after collision with `472_drop_member_profiles_primary_brand_domain.sql` on main) adds `'owner_test'` to both `triggered_by` CHECK constraints. DDL lock guard via `SET lock_timeout = '5s'`.

Last-write-wins on `(agent_url)` for the canonical status row, pinned by `compliance-db-last-write-wins.test.ts`.

Out of scope (follow-ups, not part of this PR):
- Badge issuance on owner_test transitions (owner waits up to 1h for next heartbeat to re-issue badge). Tracked separately.
- Extracting `resolveAgentOwnerOrg` to a shared helper. Current implementation duplicates the JOIN inline in `member-tools.ts`; left as-is to keep this PR's scope tight.
