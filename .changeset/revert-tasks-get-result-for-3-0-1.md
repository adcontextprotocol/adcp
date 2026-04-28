---
---

Prep main for the 3.0.1 cut:

- Revert #3126 (`tasks/get` `result` / `include_result` schema fields). The PR's own milestone was 3.1.0 — it landed early and was forcing the changeset bundle to a minor. Re-add it after 3.0.1 ships by reverting commit `f4bce25d5` on a fresh branch (or cherry-picking the original `4136a4a6d`).
- Downgrade five changesets from `minor` → `patch` where the underlying change is annotation-only, source-schema refactor, conformance-harness only, or a clarification of underspecified behavior: `add-seed-creative-format-pagination`, `fix-format-asset-oneof-titles`, `fix-get-signals-max-results-precedence`, `hoist-duplicate-inline-enums`, `hoist-inline-enum-duplicates-tranche-2`.
- Resolve the envelope-prohibition overlap on `protocol-envelope.json`: keep the top-level `not: { anyOf: [{ required: [task_status] }, { required: [response_status] }] }` constraint (from `envelope-forbid-legacy-status-fields.md`) and remove the redundant per-property `not: {}` markers added by the same PR that introduced the v3 envelope integrity storyboard. Storyboard narrative updated to reference the remaining constraint. `v3-envelope-integrity-conformance.md` rewritten as `patch` and scoped to the storyboard contribution only.

Result: `npx changeset status` reports a single patch bump for `adcontextprotocol`; 3.0.1 cuts cleanly.
