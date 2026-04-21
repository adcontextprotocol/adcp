---
"adcontextprotocol": patch
---

Follow-up to #2595 (error model) addressing protocol-review feedback:

- `transport-errors.mdx` gains an **"Envelope vs. payload errors"** section cross-linking to the normative two-layer model in `error-handling.mdx`. Previously the normative text was orphaned — readers landing on transport-errors had no pointer to the payload layer.
- `transport-errors.mdx` adds a sixth client-detection step for `payload.errors[0]` as a payload-layer fallback, plus a new **"Storyboard `check: error_code` contract"** section that promotes the shape-agnostic extraction contract from a YAML comment to spec-grade text.
- `state-machine.yaml` narrative prose updated from `INVALID_STATE_TRANSITION` → `INVALID_STATE` to match the validator assertions. The controller's own enum keeps `INVALID_TRANSITION` (transition-vs-state distinction is meaningful at the state-machine primitive layer).
- `comply-test-controller.mdx` gains an explanatory note distinguishing the controller-specific error enum (`INVALID_TRANSITION`, `INVALID_STATE`, `NOT_FOUND`, etc. per `comply-test-controller-response.json`) from the canonical seller-response `error-code.json` enum. Storyboard assertions on controller responses use `path: "error"`, not `check: error_code`.
- New `static/schemas/source/enums/error-code-aliases.json` template file with an empty `aliases` map and a self-describing JSON Schema. Documents the alias shape so future renames have a home without ad-hoc invention. Lint continues to warn-only on aliased codes.
- `tests/schema-validation.test.cjs` — the enum-values test now skips files with `$id` ending in `-aliases.json` (alias/metadata files are data, not enum schemas).
