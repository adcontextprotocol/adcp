---
"adcontextprotocol": minor
---

Type `notification_id` as a first-class optional field on the MCP webhook envelope (#4594).

Closes the typing gap left by the webhook-foundation changeset: `notification_id` was documented in `snapshot-and-log.mdx` Rule 1 prose and referenced in `webhooks.mdx` via a hedge clause, but absent from `mcp-webhook-payload.json`. Generated SDKs and strictly-typed receivers had to use dynamic property lookup.

**Schema change** (`core/mcp-webhook-payload.json`)
- New optional `notification_id` field, positioned alongside `idempotency_key` and `operation_id`.
- Description explicitly states presence/absence contract: present only for state-shaped notification types (currently: `impairment`); absent for point-in-time data events (`scheduled`, `final`, `delayed`, `adjusted`). For `impairment` events, equals `impairment_id`.
- No `x-entity` annotation: the entity type is polymorphic across notification_types; annotated separately on `impairment.impairment_id` as entity `"impairment"`. Follow-up: add a `"notification"` entity type to `x-entity-types.json` when creative-lifecycle and other state events land (#2261).

**Schema cross-reference** (`enums/notification-type.json`)
- `enumDescriptions.impairment` updated to call out that `notification_id` equals `impairment_id` for this type, enabling application-layer dedup distinct from transport-layer `idempotency_key` dedup.

**Docs updates**
- `docs/building/by-layer/L3/webhooks.mdx` — persistent-channel delivery semantics: replaced the hedged "or the equivalent event-scoped id" clause with a direct, normative statement distinguishing `notification_id` (state-shaped events) from `idempotency_key` (transport dedup) and explicitly carving out delivery-report fires. Updated the reliability code example to destructure `notification_id` alongside `idempotency_key`.
- `docs/protocol/snapshot-and-log.mdx` — Rule 1 `notification_id` bullet: replaced the forward-reference "Typed as a first-class envelope field via #4594 in 3.1; until that lands…" with a direct schema link, since this PR is the landing.

Non-breaking: new optional field on a schema with `additionalProperties: true`; existing receivers unaffected.

Closes #4594. Refs #4582, #2856, #4588.
