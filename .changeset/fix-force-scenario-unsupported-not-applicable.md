---
"adcontextprotocol": patch
---

spec(compliance): document `force_scenario_unsupported` — UNKNOWN_SCENARIO on force_* controller steps grades not_applicable

Sellers that implement `comply_test_controller` but have not implemented a specific `force_*` scenario arm (e.g., `force_create_media_buy_arm`) correctly return `{success: false, error: UNKNOWN_SCENARIO}`. The storyboard narrative in `create_media_buy_async.yaml` already said this grades `not_applicable` — that narrative was normative English. The runner contract, however, had no machine-readable enforcement layer for force_* scenarios (only `fixture_seed_unsupported` for auto-injected seed phases), so conforming runners were implementing FAILED instead of not_applicable.

Patch-eligibility justification (IETF errata test, playbook lines 261-265): the storyboard's own normative narrative text already required not_applicable; any runner grading FAILED was non-conforming against that existing MUST. This change adds the machine-readable form of a rule that was already in force. A conformant 3.0.0 implementation of the surrounding behavior would already have honored the narrative — the schema text closing the gap is an errata clarification, not a new requirement.

Changes:
- `storyboard-schema.yaml`: adds `force_scenario_unsupported` alongside `fixture_seed_unsupported`, with a normative MUST: detect the tuple (comply_test_controller IS present, resolved payload scenario begins with `force_`, response {success: false, error: UNKNOWN_SCENARIO}) and grade not_applicable before evaluating declared validations. Documents detection order to prevent misgrading absent-tool cases.
- `runner-output-contract.yaml`: adds `fixture_seed_unsupported`, `force_scenario_unsupported`, and `unresolved_scenario_reference` as recognized narrower detail values under canonical reason `not_applicable`, with the encoding MUST for `force_scenario_unsupported`.

No storyboard YAML changes — `create_media_buy_async.yaml`'s narrative was already correct; this closes the machine-readable gap the runner was missing. Runner implementation fix tracked in adcp-client (sibling-repo).

Closes #4226.
