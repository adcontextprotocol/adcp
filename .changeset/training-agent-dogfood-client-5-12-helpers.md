---
---

Dogfood `@adcp/client` 5.13 seller helpers in the reference training
agent (closes adcontextprotocol/adcp#2889).

Pins `@adcp/client` to `5.13.0` (not `^5.13.0`) because 5.14 regressed
the storyboard runner — filed upstream as
adcontextprotocol/adcp-client#866. The adoptions below all exist in
5.11+ / 5.13.0.

- **`wrapEnvelope`** replaces hand-rolled sibling-field emission
  (`replayed` / `context` / `operation_id`) in
  `framework-server.ts`'s `toAdaptedResponse` / `serviceUnavailable` /
  `versionUnsupported`.
- **Session-scoped `testController.getSeededProducts` callback** wires
  `comply_test_controller.seed_product` fixtures through `get_products`
  responses on sandbox requests — new behavior that closes a latent
  gap where seeded products never surfaced through the buyer-facing
  tool. `SEED_PRODUCT_DEFAULTS` provides the schema-minimum baseline
  so sparse fixtures still pass response validation. 5.14 would
  collapse this to a `bridgeFromSessionStore(...)` one-liner; deferring
  that follow-up until the 5.14 storyboard regression resolves.
- **`mergeSeedProduct`** replaces the shallow-spread merge in
  `overlaySeededProducts`, gaining permissive-leaf semantics and by-id
  `pricing_options` overlay.

Not adopted — blocked on 5.14 follow-up (adcp-client#866):

- `bridgeFromSessionStore` (5.14-only) — would replace the hand-rolled
  callback with a one-liner.
- `mcpAcceptHeaderMiddleware` from `@adcp/client/express-mcp` — 5.14
  fixed the `rawHeaders` patch gap (adcp-client#825/#830). 5.13's
  version only mutates `req.headers.accept`, which doesn't propagate
  through `StreamableHTTPServerTransport`'s `@hono/node-server`-backed
  Fetch Request. Keeping the inline dual-surface rewrite in
  `index.ts` until the bump.
- Deleting `conflict-envelope.ts` + `wrapResponseForConflictRedaction`
  — 5.14 ships `sanitizeAdcpErrorEnvelope` in the dispatcher, making
  the wire-layer redactor redundant. Kept in 5.13 because
  `adcpError()` still auto-injects `recovery` on `IDEMPOTENCY_CONFLICT`
  envelopes.

Also deferred (not blocked on 5.14): migrating `comply_test_controller`
off `customTools` onto `registerTestController` for its auto-emitted
`capabilities.compliance_testing.scenarios` block. Out of scope here.

Guard rails added as comments (no code changes): the bridge-wiring
security posture (single-gate sandbox with no `resolveAccount`,
fixture data non-sensitive by design) and the custom-tool sanitizer
bypass (`handleComplyTestController` sidesteps the dispatcher's
`sanitizeAdcpErrorEnvelope` — today no `adcp_error` is emitted there,
but a future edit would need to route through `adcpError()`).
