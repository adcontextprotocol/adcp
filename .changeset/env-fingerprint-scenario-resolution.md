---
---

compliance(storyboards): richer env fingerprint + requires_scenarios orphan resolution

Two follow-ups from #2676's expert review, landing as a small bundle.

**Env fingerprint: test_kit + fixtures (#2670 part 1).** The contradiction
lint now includes `doc.prerequisites.test_kit` and a hash of top-level
`doc.fixtures` in `fingerprintEnv`. Two storyboards sharing `id` +
`comply_scenario` but loading different test kits (or seeding different
prerequisite state via the top-level `fixtures:` block) legitimately
produce different outcomes for the same request — they now land in
distinct env buckets rather than collapsing into one.

Non-breaking: adds precision without changing outcomes on today's
storyboards. Planned removal of the `sb=<doc.id>` component (so
cross-storyboard contradictions surface) remains tracked at #2670.

**Orphan-contribution: requires_scenarios resolution (#2671).** The
branch-set lint's `orphan_contribution` rule flags any `contributes_to`
flag that no `assert_contribution` step consumes. Before this change,
the walk was local to the containing doc, which false-positived on the
legitimate pattern where a parent storyboard declares
`requires_scenarios:` and the linked scenario owns the assertion.

Resolution now walks the full source tree once via
`buildScenarioFlagIndex`, producing `Map<doc.id, Set<flag>>`. Parent
docs with `requires_scenarios:` union the linked scenarios' asserted
flags into their own before the orphan check runs. Unresolved scenario
ids fall through silently — a separate scoping-lint concern.

Duplicate `doc.id` across files throws immediately in
`buildScenarioFlagIndex`: order-dependent resolution of a collision
could mask a real orphan elsewhere, so the lint surfaces the duplicate
rather than papering over it.

Tests: 21 contradiction tests (2 new env-discrimination), 19 branch-set
tests (4 new: requires_scenarios resolution, unresolved-scenario
fallback, duplicate-id throw, non-string entry skip).
