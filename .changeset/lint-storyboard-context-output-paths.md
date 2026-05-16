---
---

ci(storyboards): lint context_outputs.path against the response schema

Closes the CI-gate item on #3918. New `lint-storyboard-context-output-paths.cjs` walks every storyboard under `static/compliance/source/`, finds steps with both `response_schema_ref` and `context_outputs[]`, and verifies each `path` resolves to a defined field in the referenced response schema (descending through `$ref`, `oneOf` / `anyOf` / `allOf` variants, and `items` for numeric indices).

Catches the class of bug where a storyboard captures from a path the spec doesn't define — a real agent's response will silently miss the capture, downstream `$context.<name>` consumers see undefined values, and the storyboard nominally passes lint while failing in practice.

The lint surfaced one real typo on land: `static/compliance/source/protocols/sponsored-intelligence/index.yaml`'s `si_get_offering` step was capturing `path: 'offering_id'` from `si-get-offering-response.json`, but the schema defines `offering.offering_id` (the id is nested inside the `offering` object). Fixed in this PR.

Two captures that traverse spec-sanctioned extension points (`error.details` polymorphism keyed on `error.code`, and request-key echo through `additionalProperties: true`) are documented in `scripts/storyboard-context-output-paths-allowlist.json` with `reason` strings explaining what the lint cannot statically verify; reviewers should re-read these on spec changes that might give those polymorphisms first-class schema treatment.

Wired into the `npm test` pipeline via `npm run test:storyboard-context-output-paths`. Companion to the existing `lint-error-codes.cjs` (which already covers the `expect_error.code` half of #3918's CI-gate ask).
