---
"adcontextprotocol": minor
---

Adds webhook receiver envelope conformance coverage for delivery reporting webhooks.

- Adds `media_buy_delivery` as the task type for persistent delivery-report webhook events.
- Extends `async-response-data` with the payload-only delivery-report result shape used under `mcp-webhook-payload.result`.
- Adds receiver replay vectors that accept full MCP webhook envelopes and reject bare `notification_type` delivery results, missing envelope fields, and invalid top-level task statuses.
- Clarifies docs that reporting webhook signatures cover the exact raw bytes of the full envelope, not a reserialized inner result.

Closes adcontextprotocol/adcp#5173 and adcontextprotocol/adcp#5174.
