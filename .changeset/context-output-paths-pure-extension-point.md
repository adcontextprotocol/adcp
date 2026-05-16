---
---

ci(storyboards): adopt isPureExtensionPoint in lint-storyboard-context-output-paths

Phase 2b follow-up from #3918's expert review on PR #3942 (the `validations[].path` lint). That PR introduced the `isPureExtensionPoint` rule for `pathResolves`: when a node has `additionalProperties: true` AND no `properties` / `items` / composite variants, accept any further segments. This handles `core/context.json` and `error.details` legitimately as opaque extension points.

This PR adopts the same rule in `lint-storyboard-context-output-paths.cjs` so the two lints share consistent path-resolution semantics, and lifts the now-redundant `accounts[0].errors[0].details.suggested_billing` allowlist entry — `error.details` is a pure extension point under the rule, so the path resolves naturally.

Net result: lints have aligned semantics, allowlist shrinks from 2 entries to 1 (the remaining `idempotency_key` echo entry stays — its target schema's root is a `oneOf` with defined properties, so it's not a pure extension point under the rule).

Two new test cases added to lock in the semantics: one asserts `error.details.*` resolves via the pure-extension-point rule, the other asserts mixed schemas (like `si-get-offering-response.json`) stay strict so the `offering_id` typo from #3937 would still be caught.

Companion to #3942 — the resolver code is intentionally duplicated across the two lints rather than extracted to a shared module. Their semantic scopes differ (capture-from-path vs. assert-on-path) and the duplication is small (~60 lines of `pathResolves` / `isPureExtensionPoint` / `parsePath` / `loadSchema`); shared module is a future refactor when a third lint surfaces.
