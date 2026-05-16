---
"adcontextprotocol": minor
---

Dependency-impact cluster (3.1): media-buy `health` + `impairments[]` surface, resource-level offline states across audience/creative/catalog-item/event-source, `impairment` notification_type, and the foundational snapshot/log protocol contract + persistent webhook contract that ties it together. Two expert review cycles incorporated.

**Media buy health surface** (#2853, #2855, #2856)
- New `enums/media-buy-health.json` (`ok` | `impaired`, `default: "ok"`) — orthogonal to `media-buy-status`. A paused/pending/active buy can each be impaired without affecting `status`.
- New `core/impairment.json` — package-scoped dependency state change. Materiality: `package_ids` minItems: 1; MUST-strength for audience/event_source/property (cheap 1:N joins), SHOULD for creative/catalog_item (expensive pool joins). Sellers MAY report conservatively when uncertain; MUST NOT report when serving is provably unaffected.
- New `enums/impairment-offline-state.json` — canonical offline values (`suspended | rejected | withdrawn | insufficient | depublished`) referenced by `impairment.transition.to`. The `resource_type` ↔ `offline_state` pairing is enforced by `impairment.coherence` (#2859), not at field validation.
- New `enums/impairment-reason-code.json` — flat shared enum with per-resource-type valid subset documented in enumDescriptions.
- `core/media-buy.json` adds `health` (with `default: "ok"`) and `impairments[]`. Sellers MUST add/remove entries on next sync after the underlying resource transitions, and the snapshot MUST reflect transitions within 5 minutes of `observed_at` regardless of poll cadence.
- `enums/notification-type.json` adds `impairment` plus minimal factual enumDescriptions for the four pre-existing values. Webhook payload reuses the `impairment` shape plus the buy's updated `health`.

**Resource-level offline states** (#2838, #2857, #2858)
- `enums/audience-status.json` adds `suspended` for seller-initiated offline transitions.
- `enums/creative-status.json` enumDescriptions clarify `approved → rejected` is a valid post-approval transition.
- `enums/catalog-item-status.json` adds `withdrawn` for seller-initiated removal — distinct from `rejected` (no buyer-side resubmit path).
- `core/event-source-health.json` clarifies `insufficient` covers source-offline; disambiguate via `events_received_24h: 0`.
- Property depublication verified via brand.json / adagents.json; no per-property status field.

**Webhook foundation** (#4582 tracks 1–2)
- New `docs/protocol/snapshot-and-log.mdx` — five-rule contract:
  - **Two distinct ids** (idempotency_key per-fire; notification_id per-state-event). Same notification_id under different idempotency_keys = re-emission signal.
  - **Snapshot delta** per push event; no webhook-only state.
  - **At-least-once delivery**; snapshot is authoritative.
  - **Either path is complete** — buyers using webhooks reliably and buyers using only GET get the same data. Holds today for state events; partial for data events (#4590 closes the gap for delivery reporting).
  - **Shared id space** between push and log.
- `docs/building/by-layer/L3/webhooks.mdx` "Persistent channel contract" — at-least-once, no-ordering, per-event-type coalescence (5min for general impairment, sub-minute for latency-sensitive fraud/brand-safety subclasses), replay-via-snapshot, mutability, auth renewal, termination.
- `docs/media-buy/media-buys/lifecycle.mdx` documents the `health` surface, materiality coverage, reverse-direction rule, `impairment.coherence` invariant, the operational-vs-commercial non-goal, and a remediation-by-reason_code table.

Additive across the board: new fields, new enum values, new docs. No breaking changes; safe in a minor release. Buyers that exhaustively switch on `media-buy-status` see no change (no new status value); buyers that read `media-buy.health` see the new dependency-health signal alongside their existing `status` handling.

Refs #2838, #2853, #2855, #2856, #2857, #2858, #4582. Spin-outs: #4586 (defect signals), #4587 (advisory signals). Follow-ups: #4590 (windowed reporting pulls), #4594 (type notification_id on webhook envelope), #2859 (coherence assertion tooling), #2860 (storyboard).
