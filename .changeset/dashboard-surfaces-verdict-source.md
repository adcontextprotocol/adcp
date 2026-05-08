---
---

Dashboard `/dashboard/agents` surfaces the new `verdict_source` field on the
compliance tile and a per-run "Your test / Heartbeat / Manual / Webhook"
badge in the History panel. PR 2 of the #4247 unification stack —
read-side cleanup that lets owners distinguish their own on-demand
runs from scheduled heartbeat verdicts at a glance.

**Context.** PR #4250 added `verdict_source` to
`/api/registry/agents/:url/compliance` and `triggered_by` to each row
returned by `/api/registry/agents/:url/compliance/history`. Both fields
were unrendered in the dashboard until this PR.

**What changes.**

- Compliance tile shows `Last checked: 3m ago (your test)` /
  `(heartbeat)` / `(manual)` / `(webhook)` after the timestamp. Empty
  string when `verdict_source` is null (never run).
- History panel renders a colored badge per run row:
  - `Your test` (info-blue) for `triggered_by = 'owner_test'`
  - `Heartbeat` (neutral) for `triggered_by = 'heartbeat'`
  - `Manual` / `Webhook` (neutral) for the other enum values

No backend changes; this is pure UI surfacing of fields the API already
emits. Pre-PR-1 rows (which only have `'heartbeat'` / `'manual'` /
`'webhook'`) render with the neutral badge — no regression.

**Out of scope** (PR 3 of #4247): dropping `agent_test_history` and
backfilling owner-triggered rows. Tracked separately so the destructive
migration soaks behind the read-only UI change.
