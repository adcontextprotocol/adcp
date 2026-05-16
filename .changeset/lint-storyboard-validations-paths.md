---
---

ci(storyboards): lint validations[].path against the response schema

Closes the `validations[].path` follow-up from #3918's expert review. Companion to `lint-storyboard-context-output-paths.cjs` (#3937) — that one catches captures from undefined paths; this one catches assertions on undefined paths. Same shape of bug (storyboard authored an opinion the spec doesn't back), different surface.

`scripts/lint-storyboard-validations-paths.cjs` walks every storyboard step that declares `response_schema_ref` and at least one path-bearing validation (`field_present`, `field_value`, `field_value_or_absent`, `field_absent`) and verifies each `path` resolves to a defined field in the response schema. Non-path-bearing checks (`error_code`, `response_schema`, `http_status`, etc.) are silently skipped — they have no path to validate.

### Pure extension points

The path resolver recognizes a class of node the existing context-output-paths lint did not: a "pure extension point" — a schema with `additionalProperties: true` and NO `properties` / `items` / composite variants. Examples:

- `core/context.json` (opaque correlation data, by spec design)
- `error.details` on `core/error.json` (`additionalProperties: true` because the structured shape lives in per-error-code `error-details/<code>.json` schemas selected at runtime)

Once the resolver descends into one of these, any further path segments are accepted — the spec deliberately doesn't constrain what lives below. This is distinct from a *mixed* schema (declared `properties` AND `additionalProperties: true`, e.g. `si-get-offering-response.json`), where `additionalProperties: true` is forward-compat extension and the lint stays strict (the offering_id typo from #3937 was caught precisely because of this distinction).

### What it caught on land

Two real bugs, both fixed in this PR:

1. **`creative/build-creative-{request,response}.json` schema-ref typo.** The build_creative task lives in `media-buy/`, not `creative/`. The storyboard step's `schema_ref` and `response_schema_ref` were broken refs that the existing storyboard-response-schema lint silently passed (the schema fails to load → no validation runs). Updated to `media-buy/build-creative-request.json` / `media-buy/build-creative-response.json`.

2. **`verify_terminated_session` storyboard step asserted `success: false` on `si-send-message-response.json`.** That field doesn't exist on the schema — `si-send-message-response.json:48` explicitly states "Terminated sessions return error codes (SESSION_NOT_FOUND or SESSION_TERMINATED) instead of a success response." Restructured the step to use `expect_error: true` + `check: error_code, value: SESSION_TERMINATED` per the spec contract.

### What's allowlisted

`scripts/storyboard-validations-paths-allowlist.json` carries four entries, each with a documented `reason`:

- Three `replayed` field assertions in `idempotency.yaml` — runtime convention for idempotency-replay (response schemas have `additionalProperties: true` but don't define `replayed`). Lifting requires either adding it to the spec or a typed runner check.
- One `adcp_error` field assertion in `schema-validation.yaml` — envelope-level error field per the two-layer model in `error-handling.mdx`. Payload-schema validation can't reach the transport envelope; lifting requires the lint to recognize a small set of envelope-prefix paths and validate against `core/error.json`.

Wired into `npm test` as `test:storyboard-validations-paths`. 10 tests including source-tree regression guard, typo-detection, non-path-check skip, oneOf descent through error.json, pure-extension-point semantics, mixed-schema strictness, and allowlist enforcement.
