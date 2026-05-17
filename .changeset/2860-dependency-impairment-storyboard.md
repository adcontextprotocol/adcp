---
"adcontextprotocol": minor
---

Dependency-impact end-to-end storyboard (`media_buy_seller/dependency_impairment`) — the cross-resource exercise that drives non-NA grading of the `impairment.coherence` invariant ([adcp#2859](https://github.com/adcontextprotocol/adcp/issues/2859)).

Five phases against the compliance test controller's sandbox:

1. **setup** — discover a product, create an active media buy, sync a creative with an inline assignment, and force the creative to `approved` for a clean baseline.
2. **baseline_healthy** — `get_media_buys` MUST report `health: ok` with empty/absent `impairments[]`.
3. **transition_offline** — `comply_test_controller force_creative_status` flips the creative to `rejected` with a rejection reason.
4. **verify_impaired** — `get_media_buys` MUST report `health: impaired` with an `impairments[]` entry whose `resource_type: creative`, `resource_id` matches, `package_ids` includes the buy's package, and `transition.to: rejected`. Closes the forward + inverse rules for this transition.
5. **recover_and_verify** — flips the creative back to `approved` and reads the buy again; `health` MUST return to `ok` and `impairments[]` MUST be empty. Exercises the biconditional both directions — a seller that leaves stale impairments behind fails this phase and the runner invariant.

Wired into `protocols/media-buy/index.yaml#requires_scenarios` so every media-buy seller storyboard run grades it. Sellers that don't expose `comply_test_controller force_creative_status` grade `not_applicable` rather than fail.

Creative-track only today. Audience-track and catalog-track variants are follow-ups pending `force_audience_status` / `force_catalog_item_status` support in the compliance test controller.

Closes #2860.
