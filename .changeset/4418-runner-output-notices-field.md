---
"adcontextprotocol": minor
---

spec(compliance): standardize `notices` advisory channel on runner-output-contract.

`universal/signed-requests.yaml` already mandates an "informational notice (not a failure)" for agents that still advertise the deprecated `signed-requests` specialism — but the contract had no field for it. Runners had two bad options: bake the advisory into prose `skip.detail` strings (unparseable by dashboards), or stay silent and let sellers hit a wall at the 4.0 cut where `request_signing` becomes required and `legacy_hmac_fallback` is removed.

Adds a structured advisory channel:

- **`step_result.notices`** — per-step advisory array.
- **`run_summary.notices`** — run-scoped advisories (e.g., one `request_signing_required_in_4_0` notice per run, not per storyboard).
- Notices MUST NOT contribute to `steps_failed`, `validations_failed`, or change `step_result.passed`. They fill the gap between validation failures (agent did something wrong), skips (runner couldn't apply the storyboard), and advisory-severity validations (storyboard author marked a check non-blocking) — none of which fit "passing observation, but here's a forward-looking advisory."
- Three severities: `info` (advisory context only), `deprecation` (allowed today, spec recommends migration), `future_required` (optional today, required at a named future version with `effective_version`).
- Forward-compat: receivers MUST treat unknown `code` or `severity` values as well-formed and surface them verbatim — additive extensions ship without breaking older consumers, matching the same forward-compat rule the contract already applies to authored check kinds.

Canonical first-day codes documented under `notice.canonical_codes`:
- `signed_requests_specialism_deprecated` (deprecation, motivated by the existing SHOULD in `signed-requests.yaml:34`).
- `request_signing_required_in_4_0` (future_required, `effective_version: 4.0`).
- `legacy_hmac_fallback_removed_in_4_0` (deprecation, `effective_version: 4.0`).

`signed-requests.yaml` updated to reference the canonical code instead of the prose-only SHOULD.

Files:
- `static/compliance/source/universal/runner-output-contract.yaml` — version bumped 2.1.0 → 2.2.0 (additive). New top-level `notice:` block defines required/optional fields and canonical codes. `step_result.optional_fields` and `run_summary.optional_fields` gain `notices`.
- `static/compliance/source/universal/signed-requests.yaml` — points the existing SHOULD at the new canonical `signed_requests_specialism_deprecated` code.

SDK side (`@adcp/sdk`, `@adcp/client`) implements emission; tracked separately at adcp-client#1704.

Refs #4418.
