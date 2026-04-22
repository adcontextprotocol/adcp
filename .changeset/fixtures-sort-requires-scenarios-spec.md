---
---

compliance(storyboards): normalize fixture hash + formalize requires_scenarios flag flow

Two hygiene follow-ups from #2679's expert review.

**Fixture hash normalization (#2682).** `fingerprintEnv` in the
contradiction lint now sorts arrays within each documented fixture
category by its primary id before hashing. Two storyboards with
semantically equivalent fixtures in different array order —
`products: [A, B]` vs `products: [B, A]` — now land in the same env
bucket, closing a false-negative envelope before `#2670 part 2`
removes `sb=<doc.id>` and makes env-fingerprint precision
load-bearing. Sort keys per category: `products → product_id`,
`pricing_options → pricing_option_id`, `creatives → creative_id`,
`plans → plan_id`, `media_buys → media_buy_id`.

Unknown fixture categories throw immediately, forcing schema-doc and
lint updates to land together whenever new seed categories ship.

**Spec: flag flow across `requires_scenarios` (#2683).**
`storyboard-schema.yaml` now normatively specifies how `branch_set`
contribution flags flow between a parent storyboard and its linked
scenarios:

- A flag contributed in parent X is considered asserted if either X's
  own phases assert it or a scenario Y in `X.requires_scenarios`
  asserts it.
- Reverse flow is prohibited — scenarios MUST be internally
  self-grading to preserve standalone lintability.
- Scenario IDs must match referenced files' top-level `id:` exactly,
  and those files MUST exist at build time.

Matches the `orphan_contribution` lint behavior that landed in #2679;
the lint is now the de facto reference, and the spec prose is aligned.

Follow-up filed at #2687 for `unresolved_scenario_reference` grading
(runner + lint hard error on missing scenario files — symmetrizes
with the duplicate-id throw in `buildScenarioFlagIndex`).
