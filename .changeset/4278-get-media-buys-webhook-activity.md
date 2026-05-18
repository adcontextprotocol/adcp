---
"adcontextprotocol": minor
---

Buyer-side webhook delivery visibility for AdCP 3.1, landing #4278 alongside #4582 track 4 (standardized log surface). Two new request fields, one new response field, two new shared core schemas, and the canonical pattern documentation that future resources will follow.

### Request additions (`get-media-buys-request.json`)

- `include_webhook_activity` (boolean, default `false`) — when true, each returned media buy MAY include a `webhook_activity` array describing recent reporting and health webhook fires for the calling principal.
- `webhook_activity_limit` (integer, 1–200, default 50) — per-buy cap on returned records, most-recent first.

The two request-field names are now the **canonical opt-in convention** for any AdCP resource exposing `webhook_activity[]` (see snapshot-and-log.mdx § Webhook activity log pattern).

### Response addition (`get-media-buys-response.json#/properties/media_buys/items`)

- `webhook_activity[]` — `$ref`s the new canonical record at `/schemas/core/webhook-activity-record.json`.

### New shared core schemas (#4582 track 4)

- **`/schemas/core/webhook-activity-record.json`** — canonical record shape for a single webhook delivery attempt, intended to be `$ref`'d from any resource read that surfaces a `webhook_activity[]` log. Fields: `idempotency_key` (equals the payload's dedup key — no parallel `delivery_id`), `subscriber_id` (reserved for multi-subscriber configurations; precedent #3009), `fired_at`, `completed_at`, `notification_type` (refs the shared notification-type enum; adopters MUST add their types to that registry rather than minting a parallel enum), `sequence_number`, `attempt` (one record per attempt), `status` (`success` / `failed` / `timeout` / `connection_error` / `pending`), `url` (query+fragment stripped, secret-shaped path segments SHOULD be redacted), `http_status_code`, `response_time_ms`, `payload_size_bytes`, `error_message` (server-side classification only — never bodies or headers), and `ext` (resource-specific extension envelope per the standard AdCP pattern). Nullable fields use the draft-07 union-type idiom (`"type": ["string", "null"]` etc.); the spec's `nullable: true` OpenAPI shorthand is not part of draft-07 and is not used. Top-level `additionalProperties: false` — resource-specific extensions go on `ext`, not as ad-hoc top-level fields. This is a **deliberate departure** from the surrounding convention (every other core schema with an `ext` slot uses `additionalProperties: true`) and is the structural enforcement of the "uniform across resources" promise that justifies the hoist; future schema reviewers should not "fix" it back to `true`.
- **`/schemas/core/truncation-sentinel.json`** — universal AdCP sentinel for fields whose content has been truncated due to a size cap. Shape: `{ "_meta": { "truncated": true, "original_size_bytes": N, "preview": "...", "preview_format": "<open string>" } }`. `_meta.additionalProperties: true` so future revisions can add classification fields without a forward-compat break. `preview_format` is an open string with `text` / `json` / `base64` / `xml` / `html` listed as common values; receivers SHOULD treat unknown values as `text`. The description carries the canonical `oneOf` usage example so the first real consumer doesn't reinvent the discriminator convention. Lands now so future RFCs (notably the `include_webhook_payloads` extension) plug into a shared shape; no field uses it today.

### Normative rules (#4582 track 4)

- **Retention is MUST, not SHOULD.** Sellers that surface `webhook_activity[]` MUST retain records for at least 30 days from each record's `completed_at`. For records still in `pending` status the clock runs from `fired_at` until the attempt terminates and then resets to 30 days from `completed_at` — so retry trails do not age out mid-flight. Sellers that cannot honor the floor MUST omit the field entirely rather than return a shorter window. This gives buyers a single retention guarantee they can build debug tooling against, and gives sellers with thin storage a clean opt-out via the three-state presence semantics rather than per-seller-negotiated floors. Resolves #4278 open question.
- **Scoping** MUST be calling-principal only even when multiple principals share visibility into the same resource via account-level access.
- **One record per attempt.** Single-attempt successes appear as a single record with `attempt: 1`; retry trails appear as multiple records sharing `idempotency_key`.
- **Three-state presence.** Field omitted = seller does not surface (no persistence, OR capability surface excludes the relevant webhook channel, OR no registered endpoint for the principal); `[]` = persists but no recent fires; non-empty = actual records. Sellers MUST NOT collapse states.
- **URL privacy.** Query string and fragment MUST be stripped. Sellers SHOULD redact path segments matching obvious secret patterns (high-entropy random material, UUID / token shapes).
- **`error_message` privacy.** Server-side classification string only — never request headers, response bodies, or buyer-endpoint stack traces.

### Documentation

- New normative section **`docs/protocol/snapshot-and-log.mdx` § Webhook activity log pattern** — names the canonical record, the two request-field conventions, scoping, retention floor, three-state presence semantics, record cardinality, and privacy rules. Includes an explicit **8-item adoption checklist** so future resources have unambiguous MUST hooks. Item 1 is the **notification-channel prerequisite**: adoption requires a registered notification channel for the relevant fire types — per-buy `push_notification_config` (existing) for buy-scoped resources, or the per-account subscription model from #4582 track 3 for resources that outlive a buy. The two are different primitives that fulfill the same prerequisite. Without a channel there are no fires to log, so the rest of the checklist is gated on this item. The earlier media-buy-specific mention now cross-references the pattern. Buyers diagnosing an unexpected omission have two observable signals (`push_notification_config` registration state, seller capability declaration) to discriminate the cause without filing a ticket.
- New "Diagnosing missing fires" subsection in `docs/building/by-layer/L3/webhooks.mdx` so buyers triaging missing fires from the transport contract page can find the debug surface.
- `docs/media-buy/task-reference/get_media_buys.mdx` documents `include_webhook_activity` / `webhook_activity_limit` / `webhook_activity[]` with field table, status semantics, three-state presence, retention MUST, and a JS+Python "diagnose a webhook delivery problem" example that groups attempts by `idempotency_key` and selects the latest attempt by `attempt` number (robust against iteration order).

### Scope of this PR within #4582

- **Track 1** (snapshot/log duality doc) — already shipped at `docs/protocol/snapshot-and-log.mdx`; this PR extends it with the Webhook activity log pattern section.
- **Track 2** (persistent webhook contract) — already shipped at `docs/building/by-layer/L3/webhooks.mdx`; this PR adds the cross-link from the contract page back into the debug surface.
- **Track 3** (per-account subscription model) — explicitly **not** in this PR; targeted for 3.2.0 because it introduces a new account-level surface that needs to compose carefully with #3009 (multi-subscriber, 4.0).
- **Track 4** (standardized log surface) — **shipped here**: hoisted record schema, universal truncation sentinel, retention MUST resolution, canonical pattern documentation.
- **Tracks 5–7** (auth/transport hygiene, dedup edge cases, conformance rendezvous) — separate cadence per the epic.

### Dependency chain (informational)

Track 4's adoption checklist names a notification-channel prerequisite as item 1. The implication: media buys adopt today because their channel (per-buy `push_notification_config`) already exists. Resources that outlive a media buy — creative-lifecycle (#2261), audiences, properties, account-level governance (#1711) — are blocked on track 3 (3.2.0) for the per-account channel. Once track 3 ships, those consumers plug into this pattern's record shape, request fields, scoping, retention floor, and three-state presence — inheriting transport, subscription, and observability from #4582 rather than re-deriving any of them. The #2261 RFC itself scopes to creative-specific event payloads + state-machine transitions; everything else is inherited.

### Backwards compatibility

Both request fields are optional with default `false` / `50`; the response field is optional and absent unless `include_webhook_activity: true` is set AND the seller surfaces fire history for the buy with the required retention floor. Old clients see no change.

### Out of scope (future work)

- **`include_webhook_payloads`** — sensitive opt-in to surface request and response bodies. Carved out as a separate extension because request/response bodies warrant stricter access controls and would consume the new truncation sentinel for size-bounding.
- **Operator-facing aggregate views** across principals.
- **Cross-subscriber visibility** under #3009 — `subscriber_id` is reserved on the record shape now so #3009 can populate it without a schema break.
- **Real-time push** of webhook-activity events.
- **Replay tool** (re-fire a past delivery).

Closes #4278. Lands #4582 track 4.
