# Verification profile shadow rollout

Use this runbook before enabling the Spec/Sandbox enforcement change. Phase 1
derives candidate outcomes from compliance results already produced by ordinary
heartbeats. It adds a bounded database read/write after public processing, but
does not make another agent request or change public grading, badges, or
notifications.

## 1. Deploy disabled

Migration `571_verification_profile_shadow_rollout.sql` creates the bounded
shadow ledger and inserts the audited setting as
`{ "enabled": false, "expires_at": null }`.
After deploy, confirm the admin settings response reports it disabled.

Do not deploy the enforcement patch during this phase.

## 2. Enable collection through the authenticated admin API

From a signed-in global-admin browser session, use the same-origin console:

```js
await fetch('/api/admin/settings/verification-profile-shadow-rollout', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
}).then((response) => response.json())
```

This write is recorded in `system_settings_audit` with the authenticated
credential identifier and returns an `expires_at` value 72 hours in the future.
The lease disables itself at expiry; that transition is also recorded in the
audit table with the system auto-expiry actor. Enable it again explicitly if a
new observation window is approved. It only affects future completed heartbeat
runs.

## 3. Observe for at least 48 hours

Production and Testing endpoints become due after their configured check
intervals (defaults: 12 and 24 hours respectively). The scheduler polls hourly
in batches of 10, so those intervals are eligibility targets, not completion
SLOs: queue depth, timeouts, and inconclusive target selection can delay a
completed assessment. Wait 48 hours, then verify actual repeat-run coverage
rather than assuming the cadence delivered it. From a source checkout:

```bash
npm run audit:verification-profile-shadow -- --hours=48
```

Against the compiled production image:

```bash
fly ssh console -a adcp-docs -C \
  'node /app/dist/scripts/audit-verification-profile-shadow.js --hours=48'
```

For a restricted endpoint-by-endpoint review, add `--include-agents`. That
output includes endpoint URLs, candidate transition counts, exact badge
identity (`role` plus `adcp_version`), a separately flagged legacy-badge cohort,
per-endpoint blocking reasons, and review reasons. Do not paste it into public
issues, pull requests, or other unrestricted systems.

Before proceeding, require:

- at least 95% coverage, with both numerator and denominator limited to the
  currently eligible monitored endpoints;
- stable repeat observations for at least 95% of eligible endpoints, with no
  candidate-outcome transitions; never use an endpoint without two stable
  observations to make an individual migration decision;
- no incomplete latest runs, missing bundle evidence, unresolved
  Sandbox-applicable bundle gaps, or failures that cannot be attributed to
  their originating evidence;
- manual review of valid partial/failing candidate bundles as impact outcomes,
  rather than treating those outcomes as corrupt shadow data;
- manual review of every public-passing endpoint that is not candidate-passing
  under Spec;
- manual review of every active/degraded badge reported as affected;
- manual review of every ambiguous mixed controller/failure phase;
- an explicit owner decision on legacy Live/multi-mode badges and badges on
  unmonitored lifecycle stages.

These are decision gates, not automatic migration rules.

The shadow evaluator intentionally leaves mixed executed partial bundles
unresolved, even when their visible steps include a controller omission. The
SDK result currently does not preserve every cause that can make such a bundle
partial, so promoting it would risk hiding unrelated missing evidence. Phase 2
must not proceed until those endpoints either produce explicit controller-only
`storyboards_missing_tools` evidence or the SDK exposes complete causal bundle
data and the evaluator is reviewed again.

Also inspect the structured `Compliance heartbeat shadow flush completed after
public processing` logs over the window. Require zero setting/write errors, a
shadow write success rate of 100% for attempted rows, and no more than a 10%
increase in p95 public heartbeat processing duration or eligible queue backlog
versus the preceding 48 hours. Disable the lease and investigate if any health
threshold is missed, even when the assessment coverage gate passes.

## 4. Roll back collection at any time

Use the same endpoint with `{ "enabled": false }`; do not rely on waiting for
the 72-hour lease when an immediate stop is needed. The disable is audited and
is rechecked before each shadow write in an in-flight heartbeat batch. Rows are
scheduled for deletion after the fixed 90-day retention window.
Public behavior is unchanged whether collection is on or off.

Run `SELECT prune_verification_profile_shadow_assessments();` through the
operator database console or invoke
`pruneVerificationProfileShadowAssessments()` from a scheduled maintenance
caller. The procedure is safe while collection is disabled and reports the
number of rows deleted.

## 5. Phase 2 only after review

The enforcement change must remain a separate deployment. Rebase it onto the
then-current main branch, renumber its migration after this phase's `571`,
rerun its migration and concurrency tests, and stage it behind its own
canary/rollback control. Do not infer an endpoint's selected profile solely
from the shadow recommendation; owner choice and communication are required
before any badge revocation or public status change.
