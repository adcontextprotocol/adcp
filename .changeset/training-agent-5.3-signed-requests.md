---
---

Training agent: bump to @adcp/client 5.3.0 and wire inbound request-signing.

**@adcp/client 5.2.0 → 5.3.0.** Picks up 5.3's `applyBrandInvariant` fix for
tools that declare `account` but not top-level `brand` (closes the
`MEDIA_BUY_NOT_FOUND-on-read` pattern that was blocking `get_media_buys` /
`get_media_buy_delivery` in `media_buy_seller/*`), the
`ProtocolResponseParser` disambiguation that unblocks `cancel_media_buy` and
`media_buy_state_machine`, the canonical-path `error_code` reader, and
broader idempotency-key auto-injection.

**Inbound RFC 9421 request-signing verifier** (new
`server/src/training-agent/request-signing.ts`). Mounts
`createExpressVerifier` from `@adcp/client/signing` as Express middleware
on `/mcp`, configured with the compliance test JWKS
(`test-vectors/request-signing/keys.json`), an `InMemoryReplayStore`, and
an `InMemoryRevocationStore` pre-loaded with `test-revoked-2026` so vector
017 fires the expected revocation error. `required_for` is intentionally
empty (3.0 default); `supported_for` lists every mutating tool so signed
callers are verified while unsigned callers pass through. A fallback
synthesizes `req.rawBody` from `req.body` for unsigned requests when the
host app mounts the router downstream of plain `express.json()` — signed
callers still need the `express.json({ verify })` hook we install in
`http.ts` because re-serialization would not preserve signer-byte identity.

**`get_adcp_capabilities`** now declares `specialisms: ['signed-requests']`
and a `request_signing` block matching the verifier's capability.

**Auth posture documented.** Comment on `buildAuthenticator` in
`training-agent/index.ts` makes explicit that the training agent is a
public sandbox with no org allowlist — document-once rather than leave
the posture implicit. The `verify` callback still accepts any valid AAO
dashboard API key; callers who need tenant-scoped auth should extend that
callback with an allowlist check rather than reusing this authenticator.

**Storyboard runner monkey-patch retained.** 5.3 fixed the narrow
`applyBrandInvariant` issue (injects `account` alongside `brand` when
`account` is missing), but the SDK's `SingleAgentClient.validateRequest`
still calls `schema.strict().parse()`. Tools whose request schemas declare
neither `brand` nor `account` at top level (`list_creative_formats`,
`get_signals`, `activate_signal`, `sync_creatives`) still reject the
invariant-injected fields. Tracked upstream; patch stays until the SDK
either relaxes strict parsing or scopes injection.

**Results.** 437 unit/integration tests green. Storyboard compliance:
**29/55 storyboards clean, 214 steps passing** (baseline before this PR:
25/54 clean, 208 passing).

**Residual gaps** — some upstream, some in-repo follow-ups:
- `signed_requests` specialism (37 step failures): vectors POST to raw
  per-operation HTTP URLs (`/adcp/create_media_buy`), not MCP JSON-RPC.
  The storyboard runner has no `transport: 'mcp'` option for request-
  signing vectors today (`adcp grade request-signing --transport=mcp`
  does, but the storyboard runner doesn't wire it). Needs SDK work or
  per-op HTTP routes on the training agent.
- Governance enforcement correctness: agent now enforces budget checks
  when a plan exists in the session; several storyboards stack
  conflicting plans against unrelated buys and see
  `GOVERNANCE_DENIED` where they expected a different outcome. Needs
  storyboard-by-storyboard review.
- `createAdcpServer` framework migration (the big refactor):
  task-handlers.ts is still a 3,319-line hand-rolled dispatch. Migrating
  unlocks the 5.3 auto-wiring for `signedRequests`, idempotency, and
  webhooks, plus ~50% LOC reduction. Tracked; next PR.
