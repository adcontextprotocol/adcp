---
"adcontextprotocol": minor
---

Type `notification_id` as a first-class envelope field — closes a Rule 1 ambiguity on the webhook envelope contract.

**Schema** (`core/mcp-webhook-payload.json`)
- New optional top-level `notification_id` (string, 1–255 chars). Description anchored on snapshot-and-log Rule 1: stable across re-emissions, distinct from the per-fire `idempotency_key`. Population is event-shape-dependent — present on state-shaped events (equals the resource's stable id, e.g., `impairment_id`); absent on point-in-time data events (e.g., delivery report fires) per Rule 1.

**Cross-references** (`enums/notification-type.json`)
- Each enumDescription now declares its per-type `notification_id` population:
  - `impairment` → `impairment.impairment_id` (stable across re-emissions and the closing fire)
  - `scheduled` / `final` / `delayed` / `adjusted` → absent (point-in-time data events; dedupe by `idempotency_key` only)
- Future notification types declare per-type population the same way.

**Spec**
- `docs/building/by-layer/L3/webhooks.mdx` — removes the "or the equivalent event-scoped id surfaced in the payload" hedge in the persistent-channel delivery-semantics block; receivers MUST track `notification_id` for state-shaped events.
- `docs/protocol/snapshot-and-log.mdx` — Rule 1 forward-reference replaced with a direct anchor to the envelope schema and the per-type enumDescriptions.

Additive — new field is optional and existing senders/receivers continue to validate. Receivers consuming the envelope from a strictly-typed SDK gain `notification_id` at the type level instead of having to read prose.

Closes #4594. Follow-up to #4588 (snapshot-and-log Rule 1 prose) and the impairment cluster.
