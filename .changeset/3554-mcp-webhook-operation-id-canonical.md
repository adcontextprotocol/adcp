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
- Buyers MUST supply `operation_id` to the seller for every webhook registration and SHOULD generate a unique value per task invocation.
- Sellers MUST echo the buyer-supplied `operation_id` verbatim. Sellers MUST NOT derive `operation_id` by parsing `push_notification_config.url`; the URL structure is implementation-defined and opaque to the seller.
- Receivers MUST correlate webhooks using the payload field, never URL-path inspection. Buyer-side URL conventions (path templates, query parameters, opaque tokens) are routing aids for the buyer's HTTP server only.
- Seller SDKs surface `operation_id` as an explicit parameter on the send-side webhook API (e.g., Python `WebhookSender.send_mcp(operation_id=…)`); they never recover it from the URL.

Schema, normative spec text in `docs/building/by-layer/L3/webhooks.mdx#operation-ids-and-url-templates`, and `mcp-guide.mdx` field-listing updated; the broken "URL-Based Routing" anchor in `mcp-guide.mdx` is removed. Training-agent webhook emitter now includes `operation_id` in the wire payload to match the new conformance requirement. Test vectors at `static/test-vectors/webhook-payload-extraction.json` updated to satisfy the tightened schema.

Closes #3554.
