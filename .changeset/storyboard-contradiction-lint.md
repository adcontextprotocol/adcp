---
---

compliance(storyboards): contradiction lint + defensive shorthand rules (#2634)

Closes #2634 rules 1 (contradiction) and 2 (orphan contributions / peer
completeness). Rule 3 (field-entity-context) tracked at #2660 and already
shipped separately via #2668's `storyboard-context-entity` lint — this PR
does not duplicate that work.

**Contradiction lint** (`scripts/lint-storyboard-contradictions.cjs`): groups
every step-with-assertions across all storyboards by (task, canonicalized
request fingerprint, prior-state fingerprint, env fingerprint) and flags
groups whose outcomes disagree in a way no conformant agent can satisfy —
success paired with a specific error, or disjoint error-code sets.

Fingerprinting strips runtime-random fields (`idempotency_key`,
`context.correlation_id`), normalizes substitutions (`$generate:*`,
`$context.*`, `{{prior_step.*}}`, `{{runner.*}}`), and converts `Date`
objects from unquoted YAML timestamps to ISO strings. State path is
computed from prior mutating steps in the same phase + all earlier
non-optional phases, so the classic double-cancel pattern (first cancel →
success, second cancel → NOT_CANCELLABLE) doesn't collide. Storyboard
`id` is in the env fingerprint so independent test suites don't
false-positive. Branch-set peers in the same storyboard (any_of
semantics) are exempt.

**Defensive lint for the `contributes: true` shorthand** (adcp-client#693):
the `lint:storyboard-branch-sets` script now mirrors the runner's loader
rules so violations surface at build time — reject both `contributes` and
`contributes_to` on the same step, reject `contributes: true` outside a
branch_set phase, reject non-boolean values. Storyboards in this repo
still use the string form; adopting the shorthand is tracked at #2662.

**Orphan-contribution rule** in the branch-set lint: any `contributes_to`
whose flag is not consumed by an `assert_contribution` any_of somewhere
in the same storyboard is dead code. Complements `no_assertion`
(declared branch_set with no assertion) and `peer_not_declared`
(mixed-mode peers) from #2646.
