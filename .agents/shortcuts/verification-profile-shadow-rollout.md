# Verification profile shadow rollout

Use this runbook before enabling the Spec/Sandbox enforcement change. Phase 1
derives candidate outcomes from compliance results already produced by ordinary
heartbeats. It adds a bounded database read/write after public processing, but
does not make another agent request or change public grading, badges, or
notifications.

## 1. Deploy read-only comparison

Migration `591_enable_verification_profile_comparisons.sql` turns the existing
audited switch on persistently as `{ "enabled": true, "expires_at": null }`.
It records the old and new values in `system_settings_audit`. The worker reuses
completed authoritative heartbeat evidence; it sends no additional request to
an agent and changes no public status, badge, token, or notification.

The owner dashboard initially presents the result as an **agent-wide preview**.
It must not be described as an exact `(agent, role, AdCP release)` result. Role
selection remains disabled until role-scoped immutable assessments exist. A
stale, absent, malformed, or unreadable comparison is shown as unavailable and
never as passing.

Do not deploy profile selection or enforcement during this phase.

## 2. Observe ordinary production health

Every scheduled heartbeat, including an empty queue, emits the structured
`Compliance heartbeat shadow flush completed after public processing` record
with aggregate queue, outcome, skip-reason, policy/SDK/target, write-count, and
latency fields. Endpoint URLs are excluded.

Monitor normal deployments and traffic. A deployment or cache-version change
does not restart a frozen evidence window; provenance on each immutable row
identifies the source run and evaluator version. Check:

- comparison write errors and disabled writes;
- p95 public processing duration and eligible queue backlog;
- the distribution of current, stale, pending, and unavailable owner previews;
- Spec partial/failing causes and all unresolved Sandbox bundles; and
- whether evidence explanations match the source run.

The audit command remains available for aggregate and restricted diagnosis:

```bash
npm run audit:verification-profile-shadow -- --hours=48
```

Add `--include-agents` only for a restricted operator review. That output can
contain endpoint URLs and must not be pasted into public issues or pull
requests.

## 3. Disable or re-enable collection

From a signed-in global-admin browser session, use the same-origin console:

```js
await fetch('/api/admin/settings/verification-profile-shadow-rollout', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
}).then((response) => response.json())
```

Use `{ "enabled": false }` to stop future writes and `{ "enabled": true }` to
resume them. The persistent switch has no automatic expiry. Each change is
audited with the authenticated credential identifier, and the setting is
checked atomically with every insert. Existing rows expire under the fixed
90-day retention policy. Public behavior is unchanged either way.

Retention cleanup continues through the scheduled heartbeat maintenance seam
while collection is disabled. Do not mutate rollout state or prune rows through
a direct database session during an audited rollout.

## 4. Phase 2 only after working-group review

The enforcement change must remain a separate deployment. It is blocked until
the working group decides the JWT grading-profile claim, Sandbox launch gate,
and Legacy lifetime. Sandbox also requires reviewed causal-bundle evidence and
a versioned published exception catalog. The selection data model must be keyed
to exact `(agent_url, role, adcp_version)` identity with immutable source-run
provenance, authenticated optimistic concurrency, and append-only audit history.
Never infer an owner's selection from the evaluator recommendation.
