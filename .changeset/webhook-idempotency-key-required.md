---
"adcontextprotocol": minor
---

Require `idempotency_key` on every webhook payload (#2416).

Webhooks use at-least-once delivery, so receivers must dedupe. Prior to this change, only `mcp-webhook-payload` carried fields usable for dedup — and only as the fragile `(task_id, status, timestamp)` tuple, which collides when a single transition is retried with unchanged timestamp or when two transitions share a timestamp. The governance, artifact, and revocation webhook payloads had no standardized dedup field at all; `revocation-notification` used its own `notification_id` with a different name and format.

Every webhook payload now carries a required, sender-generated `idempotency_key` stable across retries of the same event. The field uses the same name and format as the request-side `idempotency_key` (16–255 chars, `^[A-Za-z0-9_.:-]{16,255}$`). UUID v4 is required to be cryptographically random — predictable keys allow pre-seeding a receiver's dedup cache to suppress legitimate events.

**Schemas changed (required `idempotency_key` added):**
- `core/mcp-webhook-payload.json`
- `collection/collection-list-changed-webhook.json`
- `property/property-list-changed-webhook.json`
- `content-standards/artifact-webhook-payload.json`
- `brand/revocation-notification.json` — also renames the prior `notification_id` field to `idempotency_key` (safe in 3.0-rc, unifies the protocol-wide dedup vocabulary)

**Docs updated:**
- `docs/building/implementation/webhooks.mdx` §Reliability — makes `idempotency_key` the canonical dedup field with normative sender/receiver requirements: cryptographic-random keys, sender-scoped dedup (never trust a payload field for sender identity), 24h minimum TTL, cache-growth bounds, and an explicit note that webhooks do not verify payload equivalence (unlike request-side `IDEMPOTENCY_CONFLICT`).
- `docs/governance/collection/tasks/collection_lists.mdx`, `docs/governance/property/tasks/property_lists.mdx` — example payloads include `idempotency_key`; property example also adds the `signature` field that was missing.
- `docs/governance/content-standards/implementation-guide.mdx` — artifact webhook example updated.
- `docs/brand-protocol/tasks/acquire_rights.mdx`, `docs/brand-protocol/walkthrough-rights-licensing.mdx` — revocation notification references use `idempotency_key`.

Note: `core/reporting-webhook.json` is the reporting webhook *configuration* (passed in `create_media_buy`), not a payload. No reporting-webhook payload schema exists today, so it is out of scope. If one is added later, it will need the same field.
