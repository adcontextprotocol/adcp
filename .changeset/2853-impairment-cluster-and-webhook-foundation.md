---
"adcontextprotocol": minor
---

Dependency-impact cluster (3.1): media-buy `health` + `impairments[]` surface, resource-level offline states across audience/creative/catalog-item/event-source, `impairment` notification_type, and the foundational snapshot/log protocol contract + persistent webhook contract that ties it together.

**Media buy health surface** (#2853, #2855, #2856)
- New `enums/media-buy-health.json` (`ok` | `impaired`) — orthogonal to `media-buy-status`. A paused/pending/active buy can each be impaired without affecting `status`.
- New `core/impairment.json` — package-scoped dependency state change. Materiality rule: `package_ids` minItems: 1, no cosmetic-only entries.
- New `enums/impairment-reason-code.json` — flat shared enum (`policy_violation`, `consent_expired`, `ttl_expired`, `pii_audit_failed`, `seller_removed`, `content_rejected`, `source_offline`, `property_depublished`) with per-resource-type valid subset documented in enumDescriptions.
- `core/media-buy.json` adds `health` and `impairments[]`. Sellers MUST add/remove entries on next sync after the underlying resource transitions and MUST keep `health` coherent with `impairments[]` emptiness.
- `enums/notification-type.json` adds `impairment` (single new value; defect and advisory signals spin out to #4586 and #4587). Webhook payload reuses the `impairment` shape plus the buy's updated `health`.

**Resource-level offline states** (#2838, #2857, #2858)
- `enums/audience-status.json` adds `suspended` for seller-initiated offline transitions (consent expiry, PII audit failure, TTL, policy enforcement).
- `enums/creative-status.json` enumDescriptions clarify `approved → rejected` is a valid post-approval transition (policy enforcement, takedown, content drift). Sellers MUST surface a corresponding impairment.
- `enums/catalog-item-status.json` adds `withdrawn` for seller-initiated removal — distinct from `rejected` (no buyer-side resubmit path).
- `core/event-source-health.json` clarifies `insufficient` covers the source-offline case (disambiguate via `events_received_24h: 0`); sellers MUST surface a corresponding impairment for buys whose goals depend on the offline source.
- Property depublication is verified via `brand.json` / `adagents.json`; no per-property status field added.

**Webhook foundation** (#4582 tracks 1–2)
- New `docs/protocol/snapshot-and-log.mdx` — the five-rule contract tying every read API to its push channel (stable id, snapshot delta, at-least-once with snapshot authoritative, replay via re-read, shared id space). All current and future push channels reference this.
- `docs/building/by-layer/L3/webhooks.mdx` adds a "Persistent channel contract" section covering delivery semantics, coalescence, replay, mutability, auth renewal, and termination for `push_notification_config` and `reporting_webhook` on media buys.
- `docs/media-buy/media-buys/lifecycle.mdx` documents the `health` surface, materiality, reverse-direction, and the `impairment.coherence` invariant.

Additive across the board: new fields, new enum values, new docs. No breaking changes; safe in a minor release. Buyers that exhaustively switch on `media-buy-status` see no change (no new status value); buyers that read `media-buy.health` see the new dependency-health signal alongside their existing `status` handling.

Refs #2838, #2853, #2855, #2856, #2857, #2858, #4582. Spin-outs: #4586 (defect signals), #4587 (advisory signals).
