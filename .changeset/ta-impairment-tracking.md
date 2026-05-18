---
"adcontextprotocol": minor
---

feat(training-agent): impairment tracking on media buys — creative-status transitions propagate to media_buy.impairments[].

Closes #4719. Two storyboards added in #4677/#4685 (`media_buy_seller/dependency_impairment` and `dependency_impairment_cardinality`) needed full impairment-tracking machinery: when a creative referenced by a media buy's package transitions to `rejected`, the buy MUST surface `health: "impaired"` and an `impairments[]` entry; when the buyer recovers via assignment swap, the impairment MUST clear.

**Model.** Adds `impairments?: Impairment[]` to `MediaBuyState` (`server/src/training-agent/types.ts`). Impairment shape mirrors `static/schemas/source/core/impairment.json` — `impairment_id`, `resource_type`, `resource_id`, `package_ids`, `transition`, `reason_code`, `observed_at`.

**Propagation.** `comply-test-controller.ts:forceCreativeStatus` now calls `propagateCreativeImpairment` after mutating creative status. Walks `session.mediaBuys`, finds buys whose packages reference the creative, and appends/removes an impairment entry per direction (`approved → rejected` appends; `rejected → approved` removes). Idempotent on re-emission.

**Recovery.** `handleUpdateMediaBuy`'s `creative_assignments` replacement path recomputes the buy's open impairments: any creative-impairment whose `resource_id` is no longer referenced by any package on the buy is dropped. This is the canonical recovery vector — the buyer swaps the offline creative for an approved sibling.

**Response surface.** `handleGetMediaBuys` now emits `health` (`'impaired'` when `impairments.length > 0`, else `'ok'`) and `impairments[]` per the spec.

**Comply config.** `force_creative_status` adapter wired into the `/sales` tenant's `buildSalesComplyConfig` (was missing — the storyboards reported `force_scenario_unsupported`).

**Storyboard scenario adjustments.** The v6 SDK's `SalesPlatform.syncCreatives(creatives, ctx)` signature drops the request-level `assignments[]` field — the platform method has no surface for inline assignments. Both dependency_impairment scenarios are restructured to do the binding via `update_media_buy.packages[].creative_assignments` after `sync_creatives`, which is the spec's canonical surface for the binding anyway. Filed upstream at `adcontextprotocol/adcp-client#1842` to thread assignments to the platform.

`dependency_impairment_cardinality` also needed an explicit `bid_price` on its `create_media_buy` request — the product returned for its slightly-different brief picks an auction-pricing option as `pricing_options[0]`, and the seller correctly requires `bid_price` for auction. The parent `dependency_impairment` scenario happens to land on a fixed-price option and didn't need it.

Sales floor lifts from 72:340 to 74:380 (+1-clean buffer below observed 75:398).

Files:
- `server/src/training-agent/types.ts` — `MediaBuyState.impairments`, `Impairment` interface.
- `server/src/training-agent/comply-test-controller.ts` — `propagateCreativeImpairment`, called from `forceCreativeStatus`.
- `server/src/training-agent/task-handlers.ts` — `health`/`impairments` in `handleGetMediaBuys`; assignment-swap impairment clearing in `handleUpdateMediaBuy`.
- `server/src/training-agent/tenants/comply.ts` — `force_creative_status` adapter.
- `static/compliance/source/protocols/media-buy/scenarios/dependency_impairment.yaml` — split `sync_creative_with_assignment` into `sync_creative` + `assign_creative_to_package`.
- `static/compliance/source/protocols/media-buy/scenarios/dependency_impairment_cardinality.yaml` — same split + `bid_price: 10.0` on packages.
- `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh` — floor bump.
