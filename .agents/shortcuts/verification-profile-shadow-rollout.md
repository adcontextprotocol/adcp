# Verification profile shadow rollout

Use this runbook before enabling the Spec/Sandbox enforcement change. Phase 1
derives candidate outcomes from compliance results already produced by ordinary
heartbeats. It adds a bounded database read/write after public processing, but
does not make another agent request or change public grading, badges, or
notifications.

## 1. Deploy disabled

Migration `572_verification_profile_shadow_rollout.sql` creates the bounded
shadow ledger and inserts the audited setting as
`{ "enabled": false, "expires_at": null }`.
After deploy, confirm the admin settings response reports it disabled.

Before enabling, collect a full 48-hour disabled baseline from the deployed
worker's structured `Compliance heartbeat shadow flush completed after public
processing` records. Every scheduled heartbeat, including an empty queue, must
emit this record with:

- `publicProcessingDurationMs`;
- `queue.eligibleBacklog`, `queue.selectedCount`, and `queue.batchLimit`;
- policy, SDK, selected target, and compliance-cache versions in `inputs`;
- aggregate `outcomes` and `skipReasons` (never endpoint URLs); and
- shadow candidates, attempts, writes, disables, setting/write errors, and
  write latency.

Do not infer a zero backlog from missing logs. Missing baseline samples make
the health comparison unproven. Record the deployed image SHA, policy version,
SDK version, and compliance-cache/catalog version at baseline start. Freeze
those worker/compliance inputs through the baseline and observation window. A
change to any of them, or a machine-convergence gap, invalidates the comparison
and requires a fresh disabled baseline.

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

Candidate transitions compare only the version, proposed Spec/Sandbox statuses,
and recommendation. The repeat gate counts only complete, bundle-backed
observations with no unattributed failures or Sandbox-applicable unresolved
bundles. Evidence-count changes are reported separately for manual review;
they do not by themselves mean that the candidate outcome flapped.
Endpoints with no assessment are labeled `not_assessed` instead of being
misreported as incomplete runs with missing bundle evidence.
The aggregate report also separates unassessed endpoints by absent, recent, or
stale latest public runs. Restricted output identifies whether the latest
public run had no track evidence. These diagnostics explain coverage failure;
they never remove an endpoint from the denominator or turn it into a pass.

Before proceeding, require:

- at least the requested observation window since the first assessment written
  by the current policy version (the audit fails closed before that age);
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

Any change to evaluator semantics must advance
`VERIFICATION_PROFILE_SHADOW_POLICY_VERSION`. Re-enable the audited lease after
deploying that change and start a new 48-hour window; never combine observations
from two policy versions to satisfy coverage or stability gates.

When a prior window failed and a replacement evidence stream is intentionally
started, advance the policy version even if candidate grading is unchanged.
This makes the first write the unambiguous start of the replacement window and
prevents old policy history from satisfying the minimum-age gate.

The shadow evaluator intentionally leaves mixed executed partial bundles
unresolved, even when their visible steps include a controller omission. The
SDK result currently does not preserve every cause that can make such a bundle
partial, so promoting it would risk hiding unrelated missing evidence. Phase 2
must not proceed until those endpoints either produce explicit controller-only
`storyboards_missing_tools` evidence or the SDK exposes complete causal bundle
data and the evaluator is reviewed again.

Also inspect the structured heartbeat health logs over the window. Account for
every scheduled tick with either a health record or an explicit same-job
overlap skip, require zero setting/write errors, a shadow write success rate of
100% for attempted rows, and no more than a 10% increase in p95 public heartbeat
processing duration or p95 eligible queue backlog versus the frozen disabled
baseline. Treat missing ticks, missing fields, or a changed worker/compliance
input as unproven. Disable the lease and investigate if any health threshold is
missed, even when the assessment coverage gate passes.

## 4. Roll back collection at any time

Use the same endpoint with `{ "enabled": false }`; do not rely on waiting for
the 72-hour lease when an immediate stop is needed. The disable is audited and
is rechecked before each shadow write in an in-flight heartbeat batch. Rows are
scheduled for deletion after the fixed 90-day retention window.
Public behavior is unchanged whether collection is on or off.

Retention cleanup continues through the scheduled heartbeat maintenance seam
while collection is disabled. Do not mutate rollout state or prune rows through
a direct database session during an audited rollout.

## 5. Phase 2 only after review

The enforcement change must remain a separate deployment. Rebase it onto the
then-current main branch, renumber its migration after this phase's current migration,
rerun its migration and concurrency tests, and stage it behind its own
canary/rollback control. Do not infer an endpoint's selected profile solely
from the shadow recommendation; owner choice and communication are required
before any badge revocation or public status change.
