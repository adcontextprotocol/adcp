---
"adcontextprotocol": minor
---

Define AdCP 3.2 storyboard fixture resolution. Fixture IDs remain literal seed
IDs for compatibility and become run-scoped handles when a storyboard opts into
explicit `seed`, `discover`, or future entity-specific `construct` strategies.
Add deterministic matching and binding rules, schema-aware ID substitution,
resolution evidence, `fixture_unsatisfied` coverage grading, controller ID
`x-entity` annotations, authoring documentation, and a source lint. Pilot the
discovery contract on the `sales_non_guaranteed` specialism without changing
legacy runner behavior.
