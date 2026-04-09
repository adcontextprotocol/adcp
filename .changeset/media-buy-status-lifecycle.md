---
"adcontextprotocol": major
---

Restructure media buy lifecycle statuses and add compliance testing capability declaration.

**MediaBuyStatus enum changes (#2026)**
- `pending_activation` removed — replaced by two distinct statuses with clearer semantics
- `pending_creatives` added — media buy is approved but has no creatives assigned; buyer must call `sync_creatives` before the buy can serve
- `pending_start` added — media buy is ready to serve and waiting for its flight date to begin
- Lifecycle: `create_media_buy` → `pending_creatives` → `pending_start` → `active` → `paused` → `completed`
- Rejection valid from `pending_creatives` or `pending_start` only (not `active`)
- Legacy alias: `pending` continues to map to `pending_start`

**Compliance testing protocol (#2030)**
- `compliance_testing` added to `supported_protocols` enum in `get_adcp_capabilities`
- New `compliance_testing` capability section declares which `comply_test_controller` scenarios the agent supports
- Agents that implement `comply_test_controller` should declare `compliance_testing` in their capabilities

**Storyboard validation fixes (#2026)**
- `results[0].action` → `creatives[0].action` (sync_creatives response)
- `media_buys` → `media_buy_deliveries` (get_media_buy_delivery response)
- `renders[0].url` → `renders[0].preview_url` (preview_creative response)
- Added missing `value:` to 7 `field_value` validation checks
- Added `value` property to storyboard validation schema

**Migration required for `pending_activation` consumers:**
- Replace `pending_activation` with `pending_start` in status filters and comparisons
- Add `pending_creatives` to status filter arrays where you filter for non-active buys
- Update state machine logic: `pending_creatives` → `pending_start` transition happens when creatives are assigned
