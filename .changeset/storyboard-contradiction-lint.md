---
---

compliance(storyboards): contradiction lint + contributes shorthand (#2634)

Closes #2634 rules 1 (contradiction) and 2 (orphan contributions / peer
completeness). Rule 3 (field-entity-context) filed as #2660 — requires an
upstream schema-annotation pass before the lint is tractable.

**Contradiction lint** (`scripts/lint-storyboard-contradictions.cjs`): groups
every step-with-assertions across all storyboards by (task, canonicalized
request fingerprint, prior-state fingerprint, env fingerprint) and flags
groups whose outcomes disagree in a way no conformant agent can satisfy —
success paired with a specific error, or disjoint error-code sets.

Fingerprinting strips runtime-random fields (`idempotency_key`,
`context.correlation_id`) and normalizes substitutions (`$generate:*`,
`$context.*`, `{{prior_step.*}}`, `{{runner.*}}`). State path is computed
from prior mutating steps in the same phase + all earlier non-optional
phases, so the classic double-cancel pattern (first cancel → success,
second cancel → NOT_CANCELLABLE) doesn't collide. Storyboard `id` is in
the env fingerprint so independent test suites don't false-positive.
Branch-set peers in the same storyboard (any_of semantics) are exempt.

**Contributes shorthand** (adcp-client#693, `@adcp/client` 5.8.0):
`contributes: true` inside a `branch_set:` phase resolves to the enclosing
phase's `branch_set.id`. The `lint:storyboard-branch-sets` script mirrors
the runner's loader rules: reject both `contributes` and `contributes_to`
on the same step, reject `contributes: true` outside a branch_set phase,
reject non-boolean values. Migrated `schema-validation.yaml` (past-start)
and `security.yaml` (auth mechanism) to the shorthand end-to-end.

**Orphan-contribution rule** in the branch-set lint: any `contributes_to` /
`contributes: true` whose resolved flag is not consumed by an
`assert_contribution` any_of somewhere in the same storyboard is dead code.
Complements `no_assertion` (declared branch_set with no assertion) and
`peer_not_declared` (mixed-mode peers) from #2646.

Bumps `@adcp/client` to ^5.8.0.
