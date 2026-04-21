---
---

compliance(storyboards): fail the build when a storyboard declares `auth: { value: "<literal>" }` (#2720).

Adds `scripts/lint-storyboard-auth-shape.cjs` — a fifth per-storyboard lint that walks every step's `auth:` block and flags the literal-credential antipattern with a stable rule id (`literal_value`). The error message lists the three conventional replacements (`from_test_kit: true`, `from_test_kit: "<path>"`, `value_strategy: <strategy>`) alongside `auth: none` for strip-credentials cases.

The contradiction lint's `describeStepAuth` (#2708) already tolerates literal values via a sha1-8hex hash as defense-in-depth, but that's a bucket-avoidance mechanism for fingerprint purposes, not an endorsement of the pattern. This lint is the authoring guard that keeps literal credentials from ever entering source — they bind the storyboard to a specific value, can't rotate without rewriting, and leak plaintext identity into the repo.

The new lint runs in `build:compliance` after the four existing storyboard lints; current suite passes clean. It's also wired into `npm test` so CI picks it up alongside its siblings. `lint(dir)` accepts an optional directory override for testability. `tests/lint-storyboard-auth-shape.test.cjs` covers the source-tree guard, the rule's positive and negative cases (object with string `value:` flagged; `from_test_kit`/`value_strategy`/`none`/absent/value-absent all pass), defensive handling of non-string `value:` shapes, error-message anchoring so the suggested replacements can't silently drop out, and a synthetic-tree end-to-end test that exercises the full walker → aggregation path with multi-file / multi-phase / unnamed-phase coverage.

Schema documentation in `static/compliance/source/universal/storyboard-schema.yaml` updated to declare the rule explicitly, with a forward-compatibility pointer to the multi-principal `from_test_kit: "<path>"` shape.
