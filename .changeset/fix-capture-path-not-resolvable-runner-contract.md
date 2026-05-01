---
---

fix(compliance): define capture_path_not_resolvable and unresolved_substitution in runner output contract (#3796)

Adds the output shapes for two grading codes that were defined in
`storyboard-schema.yaml` but missing from `runner-output-contract.yaml`,
leaving runners without a normative spec to implement against. Without
these shapes, runners silently swallowed context-extraction failures and
reported them as downstream substitution skips rather than as failures
on the capturing step — making the diagnostic point at the wrong place.

Changes:
- `runner-output-contract.yaml` (v1.1.0 → v1.2.0): adds
  `capture_path_not_resolvable` and `unresolved_substitution` to the
  `validation_result.check` enum with defined `expected`, `actual`, and
  `json_pointer` semantics; documents that null/empty-string resolutions
  are equally non-resolvable; adds a `run_summary` note that capture
  failures contribute to `steps_failed` (not `steps_skipped`).
- `storyboard-schema.yaml`: strengthens the `context_outputs` runner
  behavior note and the grading-code descriptions to cover null/"" cases
  explicitly, and adds cross-references to the output shapes in
  runner-output-contract.yaml.
- `signal-marketplace/index.yaml`: adds explicit `field_present` check
  for `signals[0]` on the `search_by_spec` step, making the array
  non-empty assertion visible rather than relying on nested-path checks
  to implicitly catch an empty array.

The runner fix (implementing `capture_path_not_resolvable` in
adcp-client) is tracked separately — this PR ships the normative spec
the runner needs.
