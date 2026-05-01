---
"adcontextprotocol": patch
---

Add optional `provides_state_for: <step_id> | <step_id>[]` field to the storyboard step schema, declaring that a stateful step's pass establishes equivalent state for the named peer step(s) in the same phase. Pairs with the cascade-skip mechanism in `@adcp/sdk` 6.5.0+: when a peer step would otherwise grade `missing_tool` or `missing_test_controller`, the substitute waives the cascade and the runner grades the peer with skip reason `peer_substituted` (new in `runner-output-contract.yaml`).

**Storyboard schema (`static/compliance/source/universal/storyboard-schema.yaml`):** documents the field next to `contributes_to`, including the all-of array semantics, same-phase-only constraint, target-stateful / substitute-stateful requirement, and acyclic-peer-graph rule.

**Runner output contract (`static/compliance/source/universal/runner-output-contract.yaml`):** adds the `peer_substituted` skip reason to `skip_result.reasons` with detail format `"<this_step_id> state provided by <peer_phase_id>.<peer_step_id>"`. Kept distinct from `peer_branch_taken` (branch-set routing) and `not_applicable` (coverage gap).

**Specialism YAML (`static/compliance/source/specialisms/sales-social/index.yaml`):** declares `provides_state_for: sync_accounts` on the `list_accounts` step in `account_setup`. Lets explicit-mode social platforms (Snap, Meta, TikTok) — which intentionally pre-provision advertiser accounts out-of-band and expose only `list_accounts` — graduate from `1/9/0` to `9/10` on the `sales_social` storyboard once the SDK cache refreshes against this version.

**Build-time validation (`scripts/lint-storyboard-provides-state-for.cjs`, `tests/lint-storyboard-provides-state-for.test.cjs`):** new lint rule wired into `build-compliance.cjs` covering shape, self-reference, unknown target, cross-phase reference, target-stateful, substitute-stateful, and direct-cycle violations. Source tree passes with the one new declaration above.

Pure additive change; existing storyboards without the field keep their current cascade behavior. Backports to the 3.0.x line per adcontextprotocol/adcp#3734.

Closes #3734.
