---
---

Add `docs/building/verification/how-grading-works.mdx` explaining how the runner resolves specialism manifests into graded scenarios and evaluates per-scenario capability gates. Fixes a docs gap where an adopter claiming `sales-guaranteed` had no single page explaining which storyboards would run against their agent. Also corrects the `sales-guaranteed` specialism narrative which incorrectly stated that omitting `media_buy.supports_proposals` would trigger proposal grading (schema default is `false`, so omit = skip). Resolves #4037.
