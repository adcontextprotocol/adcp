---
"adcontextprotocol": patch
---

spec: extend `x-entity` annotation to media-buy, creative, and signals domains (#2660 phase 2)

Follows phase 1 (#2668) which added the `x-entity` annotation registry and the cross-storyboard context-entity lint with `brand/` annotated as the canonical case. Phase 2 sweeps the three sales-flow domains — where most real `$context` capture/consume flows happen — and annotates the core/ shared types they share.

Annotations added (no new entity types needed from the registry):

- **Core shared types** (single edit propagates to every `$ref` site): `core/account.json`, `core/account-ref.json`, `core/media-buy.json`, `core/package.json`, `core/product.json`, `core/catalog.json`, `core/creative-asset.json`, `core/creative-assignment.json`, `core/format-id.json`, `core/signal-id.json`, and the core task shapes (`protocol-envelope`, `tasks-get-request`, `tasks-get-response`, `tasks-list-response`, `mcp-webhook-payload`)
- **media-buy/**: `media_buy_id`, `media_buy_ids[]`, `package_id`, `product_id`, `pricing_option_id`, `audience_id`, `event_source_id`, `catalog_ids[]`, `task_id` across request/response pairs; `plan_id` on `create-media-buy-request` annotated as `governance_plan`
- **creative/**: `creative_id`, `creative_ids[]`, `media_buy_ids[]`, `package_id`, `task_id` across request/response pairs
- **signals/**: `signal_agent_segment_id` (→ `signal_activation_id`), `pricing_option_id`, and `signal` via the shared `core/signal-id.json` annotation

Lint enhancement:
- Walker now reads root-level `x-entity` on composite types (oneOf/anyOf/allOf) before descending into variants. This lets shared types like `core/signal-id.json` carry one root annotation that applies to whole-object captures such as `signals[0].signal_id`, without duplicating on each variant.

Two regression-guard tests added covering the walker enhancement and array-items path resolution.

Remaining domains for follow-ups: `account/`, `governance/`, `property/`, `collection/`, `sponsored-intelligence/`.
