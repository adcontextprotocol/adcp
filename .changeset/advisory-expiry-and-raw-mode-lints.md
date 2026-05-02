---
---

feat(compliance): expires_after_version for advisory drift + attestation_mode_required:raw lint (closes #3847)

Two LOW-priority items deferred from the three-expert review of #3837 and #3838. Each is small and independent.

**Item 1 — `expires_after_version` for advisory drift**

The product-expert review of #3837 flagged that storyboards declaring `severity: advisory` during a runner-adoption window may permanently drift to advisory if the author forgets to flip back to required after the SDK ships. There's no mechanism in the spec to detect "author forgot."

- New optional `expires_after_version: "<semver>"` field on storyboard validation entries with `severity: advisory`. When set, the runner promotes the advisory to required automatically once it runs against a runner whose `@adcp/sdk` version is >= the stated value (semver compare, pre-release tags honored).
- New `validation_result.severity_promoted_from_advisory` boolean on the runner output: present when the runner promoted an advisory to required at execution time. Reports SHOULD render the original advisory status alongside the promoted state — e.g., "[REQUIRED — was advisory through SDK 6.5.0; promoted at SDK 6.5.2]".
- New build-time lint at `scripts/lint-storyboard-advisory-expiry.cjs` (warnings, not errors): surfaces `severity: advisory` declared without `expires_after_version` and without an `advisory-permanent: <reason>` marker comment. Drift is a judgment call — permanent advisories (experimental signals where the spec deliberately keeps the advisory grade) are silenced via the marker. Lint exits 0 either way.

**Item 2 — `attestation_mode_required: raw` lint**

The security-expert review of #3838 flagged that storyboards setting `attestation_mode_required: "raw"` exclude all digest-mode adopters. The spec says "use sparingly" — but soft guidance is unenforceable.

- New build-time lint at `scripts/lint-storyboard-raw-mode-required.cjs` (errors, not warnings): rejects any storyboard setting `attestation_mode_required: "raw"` on an `upstream_traffic` check without a `payload_must_contain` clause. Without `payload_must_contain`, the raw flag has no operational value (mode-agnostic assertions like `min_count`, `endpoint_pattern`, `identifier_paths`, `purpose_filter`, `since` work fine in digest mode) — it just excludes privacy-conscious adopters from the conformance signal for nothing.
- The single justification for raw mode is `payload_must_contain` — JSONPath assertions against arbitrary payload fields, which digest mode genuinely can't support. The lint enforces that justification.

**Both lints wired into:**
- `scripts/build-compliance.cjs` (sequenced after the existing `lint-storyboard-check-enum.cjs` from #3837)
- `npm test` chain (new `test:storyboard-advisory-expiry` and `test:storyboard-raw-mode-required` scripts)

**Tests:** 14 cases combined — source-tree guards plus per-rule fixtures (advisory-without-expiry, gated, permanent-marker, severity-required, raw-without-justification, raw-with-justification, mode-agnostic, non-upstream-traffic, empty-array). All pass.
