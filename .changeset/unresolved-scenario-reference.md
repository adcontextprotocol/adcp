---
---

compliance(storyboards): unresolved_scenario_reference lint + runner grading (#2687)

Closes #2687. Two coordinated changes symmetric with the duplicate-
`doc.id` throw already shipped in `buildScenarioFlagIndex`.

**Lint**: `scripts/lint-storyboard-branch-sets.cjs` gains a new
`unresolved_scenario_reference` rule. When `lintDoc` is called with a
`scenarioFlagIndex` and a `requires_scenarios:` entry in the doc isn't
a key in the index, emit a violation — once per occurrence. The rule
fires independently of `orphan_contribution`; a missing scenario
reference does not pretend the flag was asserted. Only active when
`scenarioFlagIndex` is provided (the production `lint()` driver always
passes it; unit tests without an index are unaffected).

**Spec**: `static/compliance/source/universal/storyboard-schema.yaml`
documents the runner-side grading. Per the `detailed_reason_mapping`
convention in `runner-output-contract.yaml`, runners MUST populate the
canonical `reason: not_applicable` and encode
`unresolved_scenario_reference` in `detail`. The detail shape is pinned
(`'requires_scenarios reference "<scenario_id>" did not resolve
against the source tree'`) and enumerates every unresolved id when
multiple references are broken.

An explicit anti-conflation paragraph distinguishes this reason from
`fixture_seed_unsupported`: the latter is an agent-coverage gap,
`unresolved_scenario_reference` is a source-tree authoring bug.
Dashboards and aggregators SHOULD NOT combine them.

**Audit**: verified 0 unresolved `requires_scenarios` entries in the
current source tree — safe to add the hard lint error without breaking
the build.

**Tests**: 23 branch-set tests pass (4 new: fires on unresolved,
silent without index, quiet when all resolve, fires-per-occurrence on
duplicate unresolved ids). Existing `orphan_contribution` test
unchanged.

**Follow-up**: `@adcp/client` runner will need to honor the new reason
when consuming AdCP storyboards from outside this repo (lint catches
in-repo cases pre-merge; runner behavior is defensive). Tracked
separately.
