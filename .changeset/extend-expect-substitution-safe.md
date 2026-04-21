---
---

compliance: extend expect_substitution_safe to creative-generative (#2638 follow-up)

Second consumer of the `substitution_observer_runner` test-kit contract (#2647), now that both prerequisites have merged:

- #2645 — `creative-generative` has a `catalog_augmented_generation` phase with `build_creative` returning `preview_html`
- #2647 — the observer contract is live

Adds a new `catalog_substitution_safety` phase to `creative-generative/index.yaml` mirroring the pattern already established in `sales-catalog-driven`:

1. `sync_substitution_probe_catalog` — pushes three canonical attacker-shaped values (`reserved-character-breakout`, `nested-expansion-preserved-as-literal`, `non-ascii-utf8-percent-encoding`) as catalog-item `sku` fields.
2. `build_substitution_probe_creative` — generates a creative whose impression tracker URL binds `{SKU}`, with `include_preview: true`.
3. `expect_substitution_safe` — gated on `substitution_observer_runner`. Uses fixture-lookup shape (`catalog_item_id` + `vector_name`) with `require_every_binding_observed: true`.

## sales-social deliberately deferred

Tracked as a follow-up issue in this PR's description, not landed here. `sales-social` specialisms use `sync_creatives` to register DPA templates but have no AdCP-level preview hook — social platforms substitute at serve time in their own rendering pipeline. Adding `preview_creative` to sales-social's `required_tools` would force an API surface that doesn't match real social-platform implementations. The observer contract's `preview_html` observation path assumes substitution happens in the agent being tested; for specialisms without a preview surface, a different observation hook is needed (post-impression log introspection, or a dedicated dry-run substitution endpoint). Filed as a separate issue.

No spec change. No schema change. `creative-generative` runners without the observer contract grade the new phase's `expect_substitution_safe` step `not_applicable`; the preceding two steps exercise the catalog-acceptance and build paths unconditionally.
