---
---

feat(compliance): anti-façade follow-ups — check-enum lint, advisory severity, recorded_calls purpose tagging (#3830 items 1, 3, 5)

Three of the five LOW-priority items filed against #3816 in #3830. Each is small and independent; bundled because they all tighten the same upstream_traffic / authored-check surface.

**Item 1: Build-time storyboard check-enum lint**

`runner-output-contract.yaml` now declares `authored_check_kinds` as a structured top-level list — single source of truth for what storyboards may declare in `step.validations[].check`. New lint at `scripts/lint-storyboard-check-enum.cjs` walks every storyboard and rejects:

- `unknown_check_kind`: typo or undocumented check kind. The runtime forward-compat default (unknown → not_applicable) exists for cross-version skew, not for catching typos at publish time.
- `synthesized_check_kind_authored`: storyboard declared `capture_path_not_resolvable` or `unresolved_substitution` (runner-emitted, not authored — the storyboard cannot meaningfully assert against runner-internal state).

Wired into `scripts/build-compliance.cjs` alongside the other linters and tested in `tests/lint-storyboard-check-enum.test.cjs` (6 cases — source-tree guard plus per-rule coverage with temp-dir fixtures). Test wired into `npm test`.

**Item 5: Advisory validation severity**

New optional `severity: "required" | "advisory"` field on storyboard validation entries (default: "required"). An advisory failure surfaces in `validation_result` with `passed: false` but does NOT fail the step — the step grades on its remaining required validations. Advisory failures contribute to a distinct `validations_advisory_failed` counter on `run_summary` so they stay visible without polluting conformance verdicts.

Use case: storyboards declaring `upstream_traffic` during the months between the contract spec landing and the @adcp/sdk runner shipping it. Authors flip `severity: advisory` while instrumentation matures, then drop the field once adoption is stable. Distinct from the runtime forward-compat default (runner version skew) — severity is for author-managed rollout gating.

Documented in `storyboard-schema.yaml > Validation` and `runner-output-contract.yaml > validation_result.optional_fields`.

**Item 3: `purpose` tagging on recorded_calls**

New optional `purpose` enum on `recorded_calls[].items` in `comply-test-controller-response.json`: `platform_primary` | `measurement` | `identity` | `other`. Adopters self-classify each outbound call.

New optional `purpose_filter: [string]` on `upstream_traffic` storyboard checks. When set, the assertion considers only recorded calls matching one of the listed purposes. Use case: a `sales-non-guaranteed` buyer agent creating a campaign AND calling a measurement vendor during the same `create_media_buy` step — storyboard scopes to `purpose_filter: ["platform_primary"]` so DV/IAS/Nielsen calls don't muddy the campaign-creation assertion. Storyboards that don't filter ignore the field; calls without a `purpose` field match only when `purpose_filter` is omitted (absence is ambiguous; explicit filtering requires the adopter's classification).

**Out of scope (separate PRs):**

- Item 2 (`payload_attestation` digest mode for EU adopters) — bigger spec design, separate PR.
- Item 4 (reference upstream-traffic recorder middleware) — adcp-client repo work.
