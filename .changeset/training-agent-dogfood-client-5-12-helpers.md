---
---

Dogfood `@adcp/client` 5.14 seller helpers in the reference training agent
(closes adcontextprotocol/adcp#2889).

Bumps `@adcp/client` to `^5.14.0` and adopts the helper surface end-to-end:

- **`wrapEnvelope`** replaces hand-rolled sibling-field emission
  (`replayed` / `context` / `operation_id`) in
  `framework-server.ts`'s `toAdaptedResponse`, `serviceUnavailable`, and
  `versionUnsupported`.
- **`bridgeFromSessionStore({ loadSession, selectSeededProducts, productDefaults })`**
  (new in 5.14 via adcontextprotocol/adcp-client#830) wires
  `comply_test_controller.seed_product` fixtures through `get_products`
  responses on sandbox requests. Closes the latent gap where seeded
  products never surfaced through the buyer-facing tool. `SEED_PRODUCT_DEFAULTS`
  provides the minimum schema-valid baseline so sparse fixtures still
  pass response validation.
- **`mergeSeedProduct`** replaces the shallow-spread merge in
  `overlaySeededProducts`, gaining permissive-leaf semantics and by-id
  `pricing_options` overlay.
- **`mcpAcceptHeaderMiddleware`** (5.14 now patches `rawHeaders` per
  adcontextprotocol/adcp-client#830) replaces the inline Accept header
  rewrite + `rawHeaders` mutation in `index.ts` on both `/mcp` and
  `/mcp-strict`.
- **Deleted** `server/src/training-agent/conflict-envelope.ts` and its
  test: `adcpError()` now consults `ADCP_ERROR_FIELD_ALLOWLIST` and the
  dispatcher re-applies `sanitizeAdcpErrorEnvelope` to every
  handler-returned envelope, so `recovery` no longer leaks into
  `IDEMPOTENCY_CONFLICT` responses at any layer. Added a framework-path
  regression that asserts `recovery` is absent on a real conflict
  envelope.

Not adopted — noted for follow-up:

- `createDefaultTestControllerStore` was deleted from adcp-client in
  adcontextprotocol/adcp-client#843 (replaced with a worked seller
  example); the training agent's rich-state controller stays.
- `registerTestController`'s auto-emit of the
  `capabilities.compliance_testing.scenarios` block only fires when the
  tool is registered through that helper. The training agent registers
  `comply_test_controller` via `customTools` (our wrapper handles a
  sandbox gate and session load around `handleTestControllerRequest`).
  Migrating to `registerTestController` is a larger refactor; keeping
  the manual capability override in `capabilities.overrides` until
  then.
