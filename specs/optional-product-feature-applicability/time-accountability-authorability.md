# #8254: conditional reporting authorability on SDK 15.9.5

Verdict: **existing YAML can enforce bounded same-snapshot data-or-disclosure accountability, including commitments at arbitrary indexes. It cannot faithfully derive general commitment timestamp eligibility, per-metric measurement-stage eligibility, and full/standalone parity from only a selected commercial snapshot.** These are separate findings; do not describe all conditional accountability as an SDK blocker. No implementation owner is confirmed and this evidence assigns none.

## Reproduction and qualification boundary

Run `node --test --test-timeout=30000 specs/optional-product-feature-applicability/time-accountability-authorability.test.cjs` from the repository root. The file is self-contained except for public `@adcp/sdk/testing` and the public SDK version export. It asserts unchanged installed version **15.9.5**, calls actual public `runStoryboard` and `runStoryboardStep`, and uses public `transport.trustedFetchFn` to exercise MCP initialization, tool discovery, requests, response extraction, schema validation, captures, phase grammar and shared validations. There are no private SDK imports, `_client`/`_profile` injection, network writes, dependency upgrades, or new check names.

The suite contains positive assertions and deliberately preserved counterexamples. A passing counterexample test means the attempted shortcut produced the documented false pass or false failure; it does not mean that behavior is conformant. The captured time storyboard is a byte-identical YAML snapshot of the actual held source, with original YAML SHA-256 asserted and root commit recorded beside the saved fixture load. It therefore runs independently in the decision-only proposal worktree. This probe does not qualify SDK 15.9.4, 15.9.6, or the stable 3.2.x SDK 14.0.0-rc.53, and does not resolve commercial request construction or fixture/standalone preparation holds.

## What existing source can express

Capture the entire accepted package after creation (not a possibly absent first commitment), and capture the entire package row from the report. In a subsequent phase, use:

```yaml
skip_if: context.observed.time_based_views
steps:
  - id: audit
    task: get_media_buy_delivery
    # Ordinary read request omitted here; this is an authoring sketch.
    validations:
      - check: refs_resolve
        source:
          from: context
          path: accepted.committed_metrics[*]
        target:
          from: context
          path: observed.missing_metrics[*]
        scope:
          key: metric_id
          equals: time_based_views
        on_out_of_scope: ignore
        match_keys: [scope, metric_id]
```

This is **existing syntax**, not a proposed DSL addition. The public probes prove:

* A standard time commitment at index 1 is audited; first-index-only gating is unnecessary.
* A missing time carrier plus a matching disclosure passes; losing both fails.
* A present empty `time_based_views: []` passes without invented observations, thresholds or bases.
* A contract containing only another standard metric does not force a time observation or disclosure.
* Both reference roots can be captured context. Thus a follow-up response gaining time data cannot cause the earlier report's valid missing disclosure to fail. The assertion audits the frozen earlier response, rather than incorrectly demanding missing disclosure from a newly matured response.
* With complete caller-supplied snapshots, standalone refs also pass/fail correctly for the bounded **carrier-absent** case.

This pattern is bounded to commitments already known to be in accountability scope for the report and to the appropriate standard, unqualified metric. `scope.metric_id` is only a one-key filter; it must not be advertised as a full standard/vendor/qualifier identity normalizer. Vendor metric IDs are namespaced and can equal a standard spelling (`core/vendor-metric-id.json`). Generic qualifier joins need canonical deep equality; current refs use strict JavaScript identity for object-valued match keys. Those wider identities are outside these standard-time probes.

The follow-up ordinary tool task adds a read, but its response need not be the audit target. A taskless validation-only step is not a substitute: 15.9.5 returns `fixture_unavailable`, no validations, and an output-adapter explanation. That is a real API behavior, but **does not prevent the ordinary-task/context-target pattern above**.

## What remains unproven or unavailable

**Timestamp filtering is a genuine grammar limit.** The reporting contract audits only entries with `committed_at < reporting_period.end`, strictly excluding equality. The public suite shows a first/final commitment shortcut wrongly fails valid at-end and later commitments. Phase conditions support property lookup, truthiness, `!`, strict equality/inequality, strings/booleans and OR. They reject `<`, `&&`, numeric literals and array predicates. `refs_resolve.scope` compares one property to one literal (with `$agent_url` as its only special value); it neither orders timestamps nor joins a timestamp to another context value. Existing `field_greater_than`/`field_less_than` accept finite numbers, and public execution rejects the legal ISO timestamp strings. Capturing optional `committed_metrics[0].committed_at` unconditionally would itself fail valid absent-contract cases; the suite avoids that except in the explicit date-comparison probe.

**Measurability is also an evidence/authority question.** `is_final: false` does not mean every metric is unmeasurable: some live metrics can already be measurable while later processing remains provisional. Conversely, a time commitment cannot be forced into missing disclosure during a window in which it is genuinely not yet measurable. The suite demonstrates the opposing outcomes of treating finality as a blanket skip versus requiring every commitment to disclose in every window. `measurement-window.json` defines custom stage IDs, accumulation duration, expected availability and guarantee basis; it does not provide a machine-readable per-metric window-eligibility map. Expected availability is an expectation, not a newly invented universal deadline. A selected metadata snapshot helps identify the native window and accepted terms; it does not by itself prove every metric has matured. A proposed evaluator must identify trusted existing evidence for this fact, or preserve an explicit coverage limitation. Do not silently equate an arbitrary ID `final`, guarantee-basis status, or zero expected delay with all metrics always measurable.

**Absent commitments require the current catalog, not just the initial selected snapshot.** The public transport probe reads schema-valid initial and current metadata for the same product in both directions (time support added and removed), capturing both successfully. This is authorable read/extraction work today. A refs audit over absent `committed_metrics` vacuously passes; it does not implement the normative live fallback. A general solution must obtain the same selected product's current metadata through the already-disclosed identity/pagination prerequisite and evaluate current metric membership, while preserving binding commitment independence from subsequent product mutations. No new capability declaration is justified by this finding.

**Standalone phase semantics differ.** On 15.9.5, `runStoryboardStep` executes the chosen step without evaluating its enclosing runtime `skip_if`. The public probe supplies complete prior context, including a present empty time array, yet the audit executes and incorrectly demands missing disclosure. Caller-supplied snapshots make the carrier-absent refs case work; they do not repair carrier-present branch parity. Full runs can use the bounded YAML pattern; standalone/hosted callers need explicit qualified orchestration or a separately reviewed parity correction. Do not call restored fixture IDs alone complete conditional-state preparation.

`contributes_if` is not a hidden expression evaluator: it recognizes only `prior_step.<id>.passed`. `any_of` consumes contribution flags. `not_applicable_if` on this pin supports only terminal-page gates. None supplies date parsing or metric-window authority. Programmatic public assertion registration could evaluate arbitrary logic in full runs, but is not a shared YAML implementation and does not establish standalone parity.

## Existing authority and minimum next contract

No new protocol norm is needed to require a mature, accepted, included metric to have its canonical value or applicable missing disclosure. The basis already exists in:

* `static/schemas/source/core/package.json:124`: accepted ledger, amendment timestamps, absent-ledger fallback.
* `static/schemas/source/media-buy/get-media-buy-delivery-response.json:453`: strict-before timestamp filtering; current-product fallback; exclude not-yet-measurable metrics; do not flag metrics only excluded by request narrowing.
* `static/schemas/source/core/delivery-metrics.json:225`: a time commitment contracts the array's presence, not observations or thresholds; there is no `minItems` requirement.
* `static/schemas/source/core/measurement-window.json`: stage semantics and expected availability, with no per-metric eligibility declaration.
* `docs/media-buy/task-reference/create_media_buy.mdx:349` and `:381`: day-1 timestamps and reconciliation.

The narrow reporting prerequisite should therefore preserve accepted package and report snapshots, correctly filter strict-before commitments (or supply verifiable already-qualified in-scope entries), establish metric measurability from trusted existing evidence, obtain live same-product metadata only for absent-ledger fallback, and maintain full/standalone/hosted preparation and conditional parity. Its implementation location is not decided by this analysis. Reuse existing scoped refs/context captures for the portion they already implement. Do not add a capability field, invent a time observation, turn mandatory failures into global optional checks, or claim a generic SDK blocker where source authoring already suffices.

The suite independently reproduces the **held actual time YAML false pass** in a stipulated mature-case fixture with native time support, fixed CPM, an accepted due standard-time commitment, declared final zero-delay window, final package report and **both canonical time data and missing disclosure absent**. Maturity is a stipulated fixture condition here; the final/zero-delay fields themselves do not prove general per-metric measurability. The parsed snapshot remains unchanged. This remains a reporting merge hold until a faithful qualified accountability path is implemented and reviewed; these probes are analysis, not that implementation.

SDK implementation references for the unchanged pin: `dist/lib/testing/storyboard/phase-condition.mjs:1/:97`; `validations.mjs:1655/:1778/:1788/:1887`; `runner.mjs:3250/:4646/:6453`; `types.d.ts:1121`. No SDK owner assignment/adoption is established.
