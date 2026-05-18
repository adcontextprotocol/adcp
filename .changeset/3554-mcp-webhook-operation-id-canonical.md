---
"adcontextprotocol": minor
---

MCP webhook `operation_id` is now the canonical, normative correlation identifier; URL-path parsing is forbidden ([adcp#3554](https://github.com/adcontextprotocol/adcp/issues/3554)).

Two ambiguities in 3.0 made cross-implementation interop fragile:

1. The `mcp-webhook-payload.json` description told publishers to "echo" `operation_id` back from the URL but never specified the URL-extraction convention (path segment? query parameter? template?), and the field was not in `required` — so a conformant publisher could legally omit it.
2. `docs/building/by-layer/L0/mcp-guide.mdx` marked `task_type` and `operation_id` as **deprecated** in favor of URL-path routing, directly contradicting `webhooks.mdx` (which correctly told receivers not to parse the URL) and the actual server implementation.

Resolution — every comparable async-notification protocol in ad tech (OpenRTB `nurl`/`burl`, VAST tracking pixels, A2A `PushNotificationConfig`) makes the URL opaque to the entity firing the HTTP call; AdCP now matches that precedent.

**Normative wire contract:**

- `operation_id` is now **required** in `mcp-webhook-payload.json`.
- `push-notification-config.json` gains an optional `operation_id` field as the canonical buyer→seller registration channel. Sellers MAY reject registrations without it via `INVALID_REQUEST`.
- Buyers SHOULD supply `operation_id` via `push_notification_config.operation_id` and SHOULD generate a unique value per task invocation. Buyers MAY additionally embed the same value in the URL path or query as a routing aid for their own HTTP server.
- Sellers MUST echo the buyer-supplied `operation_id` verbatim into every webhook payload. Sellers MUST NOT derive `operation_id` by parsing the URL; the URL structure is implementation-defined and opaque to the seller.
- Receivers MUST correlate webhooks using the payload field, never URL-path inspection. Buyer-side URL conventions (path templates, query parameters, opaque tokens) are routing aids for the buyer's HTTP server only.

Updated alongside:
- `docs/building/by-layer/L3/webhooks.mdx#operation-ids-and-url-templates` carries the full normative wire contract.
- `docs/building/by-layer/L0/mcp-guide.mdx` field-listing updated; broken `#best-practice-url-based-routing` anchor removed; deprecated-fields framing replaced with the canonical position.
- `docs/building/by-layer/L0/a2a-guide.mdx` "URL-Based Routing" best-practice section rewritten — A2A receivers correlate the same way as MCP receivers (payload field, never URL parsing). Closes the cross-protocol consistency gap a contributor would otherwise hit when reading the two L0 guides side-by-side.
- Training-agent webhook emitter (`server/src/training-agent/webhooks.ts`) extracts the buyer-supplied `operation_id` from `push_notification_config.operation_id` and echoes it on the wire, with `task_id` as a fallback when the buyer didn't supply one. The seller-side principal-scoped string (used to key the idempotency-key store) is renamed `deriveWebhookIdempotencyScope` and is never placed on the wire.
- Test vectors at `static/test-vectors/webhook-payload-extraction.json` updated to satisfy the tightened payload schema.

Closes #3554.
