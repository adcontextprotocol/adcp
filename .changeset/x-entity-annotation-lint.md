---
"adcontextprotocol": patch
---

spec + tooling: introduce `x-entity` schema annotation and cross-storyboard context-entity lint (#2660, rule 3 of the #2634 contradiction trio)

Adds a non-validating `x-entity` annotation that tags schema fields carrying entity identity (e.g., `advertiser_brand`, `rights_holder_brand`, `rights_grant`). Ships the annotation on `brand/` schemas — the canonical `brand_id` advertiser-vs-rights-holder conflation from #2627 — and leaves other domains silent until follow-up PRs annotate them.

- New: `core/x-entity-types.json` registry enumerating 24 entity types
- New: `scripts/lint-storyboard-context-entity.cjs` walks storyboard `context_outputs` and `$context.*` refs (both bracket `rights[0].rights_id` and dotted `rights.0.rights_id` forms), resolves `x-entity` at both ends, flags mismatches; also catches capture-name collisions and unregistered `x-entity` values with a did-you-mean suggestion
- New: `docs/contributing/x-entity-annotation.md` authoring guide (cross-linked from `storyboard-authoring.md` and `.agents/playbook.md`)
- Wired into `npm test` and `npm run build:compliance` alongside the existing storyboard lints

The lint is silent on fields without annotations, so partial rollout across the remaining domains (media-buy, signals, creative, account, governance, property, sponsored-intelligence) is safe.
