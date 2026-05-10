---
# No package bump — compliance YAML harness files are not a versioned protocol schema change.
# The storyboard source ships in dist/compliance/<version>/ on the next patch cut, not via semver.
---

fix(compliance): rotate 5 static idempotency keys in success-path storyboard steps (issue #4344)

Converts 5 hardcoded `idempotency_key` string literals to `$generate:uuid_v4#alias` form in
`sample_request` blocks that are success-path, stateful steps. Static keys in these steps cause
seller idempotency caches to return stale responses on re-runs, surfacing phantom regressions
whenever a seller deploys a response-shape change between test runs.

Files changed:
- `static/compliance/source/protocols/governance/index.yaml` — `register_plan.sync_plans`
- `static/compliance/source/specialisms/governance-delivery-monitor/index.yaml` — `plan_registration.sync_plans`
- `static/compliance/source/specialisms/creative-ad-server/index.yaml` — `report_billing.report_usage`
- `static/compliance/source/specialisms/governance-spend-authority/denied.yaml` — `plan_registration.sync_plans`
- `static/compliance/source/specialisms/governance-spend-authority/index.yaml` — `plan_registration.sync_plans`

**Not converted (intentional):** 11 remaining static keys are in steps with `expect_error: true`.
Per AdCP spec (`idempotency.yaml` line 46): "Error responses do not cache. The next request
carrying the same key re-executes the handler." A static key on an error step is correct behavior —
it surfaces the compliance violation if a seller incorrectly caches error responses. This includes
the 5 keys in `error-compliance.yaml`, 4 in `error-compliance-signals.yaml`, 1 in
`schema-validation.yaml`, and 1 `signal-gov-denied-v1` (`activate_signal_denied`, stateful+error).

Partial rollout of #4344. Issue stays open as the tracker for the error-step decision.
