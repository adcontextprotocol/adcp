---
---

spec(storyboards): promote `branch_set` to a first-class phase field (#2633)

Branch-set membership was previously inferred by correlating `contributes_to`
values with a later `assert_contribution` step's `any_of` target. Typos in
the flag silently broke membership — a conformant agent on the "correct"
branch could look like it failed everywhere.

Phases now SHOULD declare membership explicitly:

    branch_set:
      id: past_start_handled
      semantics: any_of

A new `lint:storyboard-branch-sets` script (wired into `build:compliance` and
`npm test`) enforces: branch-set phases are `optional: true`; peer phases
share `branch_set.semantics`; every declared id has a matching
`assert_contribution` any_of; nested `contributes_to` values match
`branch_set.id`.

Implicit detection is preserved as a fallback for pre-#2633 storyboards.
Contradiction lint (#2634) will build on this explicit declaration.

Migrates `universal/schema-validation.yaml` (past-start) and
`universal/security.yaml` (auth mechanism) to the explicit form.
