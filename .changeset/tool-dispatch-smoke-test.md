---
---

test(training-agent): add handler-dispatch smoke test per tool per tenant — closes #3978

Extends CI façade detection beyond name-match to dispatch coverage.
`tool-catalog-drift.test.ts` proves tool names match the catalog; this new test
proves each handler is wired: for every (tenant, tool) pair a `tools/call` with
minimal arguments must not return `NOT_IMPLEMENTED` or `UNSUPPORTED_FEATURE`.
Domain errors (`INVALID_REQUEST`, `MEDIA_BUY_NOT_FOUND`, …) are expected passes —
those confirm the handler ran.

The gap surfaced by #3962/#3976: `list_creative_formats` was advertised on
`/creative` and `/creative-builder` but the v6 platform method was missing.
Catalog drift test passed (names matched); the storyboard caught it only after a
buyer-side request was made. This test would have caught it at CI time.

**Files:**
- `server/tests/integration/training-agent-tool-dispatch-smoke.test.ts` (new)

**Implementation notes:**
- Mirrors the drift test's server-boot and MCP-over-HTTP call pattern.
- Uses `{}` as arguments for read-only tools; adds `idempotency_key` for mutating
  tools so the framework routes to the handler body.
- Does not attempt response-schema validation — `responseSchema` is not exposed on
  the advertised tool object (`tools/list` returns `inputSchema` only).
- Two assertion forms: `structuredContent.adcp_error.code` for AdcpError-wrapped
  NOT_IMPLEMENTED, plus a text-content regex check for SDK-level UNSUPPORTED_FEATURE
  strings that don't follow the adcp_error envelope.
