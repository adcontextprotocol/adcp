---
---

Training agent: JSON-only Accept header support + idempotency storyboard fixes.

- **Accept header negotiation**: the MCP Streamable HTTP transport rejects
  requests whose Accept header lacks `text/event-stream`, returning 406.
  The SDK storyboard runner's `rawMcpProbe` (used for `omit_idempotency_key`
  vectors, among others) sends `Accept: application/json` only and hits
  the 406 path, which surfaces to validations as "no response body" and
  fails every check on the step. Rewrite the Accept header (including
  Node's `rawHeaders` array, which is what `@hono/node-server` actually
  reads) to include SSE when the client sent JSON-only, and enable
  `enableJsonResponse: true` on the transport so the body is single-shot
  JSON rather than an SSE stream the probe can't parse. Bearer-authed
  buyer agents already send both content types — no hot-path regression.

- **Emit `replayed: false` on fresh create_media_buy responses**: the
  universal idempotency storyboard's `create_media_buy_initial` step
  uses `field_value allowed_values: [false]` on `replayed`, which fails
  on omission despite the spec's MAY-omit clause. Scoped to
  create_media_buy (not all mutating tools) because several SDK-
  generated response schemas reject the extra key via
  `additionalProperties: false` — tracked in adcp-client#774 (make all
  response schemas `.passthrough()`).

- **Strip `recovery` from IDEMPOTENCY_CONFLICT error envelope**: the new
  SDK cross-step assertion `idempotency.conflict_no_payload_leak`
  enforces a narrow allowlist (code, message, status, retry_after,
  correlation_id, request_id, operation_id). Our `recovery: correctable`
  hint fell outside — drop it on this specific error to satisfy the
  stolen-key read-oracle defense. Other errors keep their recovery
  hints.

Storyboard score: 43/56 → 43/56 clean, 317 → 321 steps passing (+4).
`idempotency` went from 3 failures → 1 failure (webhook-dedup on replay
still pending investigation).
