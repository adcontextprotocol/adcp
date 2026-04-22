---
---

Training agent: close two storyboard regressions from the #2663 SDK bump.

- Framework dispatch (`TRAINING_AGENT_USE_FRAMEWORK=1`) now wraps requests in
  `runWithSessionContext` + `flushDirtySessions` so media buys, creatives, and
  governance state created in one MCP call are visible in the next. Fixes the
  systemic `MEDIA_BUY_NOT_FOUND` cascade across `sales_*`, `media_buy_seller/*`,
  `media_buy_state_machine`, `creative_generative/seller`, and
  `governance_delivery_monitor`.

- `sync_creatives` no longer rejects `format_id` whose `agent_url` points at a
  different creative agent (e.g. `creative.adcontextprotocol.org`). The seller
  only validates format IDs it hosts locally; cross-agent references are
  trusted pointers resolved at render time.

- `handleCreateMediaBuy` now consults `session.complyExtensions.seededProducts`
  / `seededPricingOptions` so products seeded via `comply_test_controller`
  resolve through the normal create path. Closes the read side of the seeding
  pipeline opened by #2742.

Storyboard floors raised: legacy 36→44 clean / 295→318 passing, framework
21→37 clean / 241→308 passing. Closes follow-ups under #2667.
