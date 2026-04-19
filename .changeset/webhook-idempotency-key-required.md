---
"adcontextprotocol": minor
---

Require `idempotency_key` on every webhook payload (#2416).

Webhooks use at-least-once delivery, so receivers must dedupe. Prior to this change, only `mcp-webhook-payload` carried fields usable for dedup — and only as the fragile `(task_id, status, timestamp)` tuple, which collides when two status transitions share a timestamp. The governance and artifact webhooks had no dedup field at all.

Every webhook payload now carries a required, sender-generated `idempotency_key` stable across retries of the same event. Receivers MUST dedupe by this key; a repeat key with matching payload is a retry of an already-delivered event and MUST NOT re-trigger side effects.

**Schemas changed:**
- `core/mcp-webhook-payload.json`
- `collection/collection-list-changed-webhook.json`
- `property/property-list-changed-webhook.json`
- `content-standards/artifact-webhook-payload.json`

The field uses the same name and format as the request-side `idempotency_key` (16–255 chars, `^[A-Za-z0-9_.:-]{16,255}$`). UUID v4 is the recommended value.

Docs in `webhooks.mdx`, `collection_lists.mdx`, `property_lists.mdx`, and `content-standards/implementation-guide.mdx` updated to reflect `idempotency_key` as the canonical dedup field.

Note: `core/reporting-webhook.json` is the reporting webhook *configuration* (sent in `create_media_buy`), not a payload, so no change there. A separate reporting-webhook *payload* schema does not currently exist.
