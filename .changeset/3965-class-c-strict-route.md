---
---

fix(training-agent): restore per-tenant /<tenant>/mcp-strict, close #3965 Class C

The 6.0.0 multi-tenant migration (#3713) dropped the legacy `/mcp-strict` route along with `STRICT_REQUIRED_FOR` enforcement and `enforceSigningWhenWebhookAuthPresent`. The `signed_requests` conformance storyboard — gated on `request_signing.supported: true` AND `required_for: [...]` — failed at discovery on every tenant since then. The runner targets `/<tenant>/mcp-strict` (per `run-storyboards.ts:350-352`) but the multi-tenant migration only mounted `/<tenant>/mcp`.

Restoring per-tenant strict routes as a sibling mount: same v5 monolith handler as the legacy `/mcp` route, but stamped with `ctx.strict = true` so `selectSigningCapability(ctx)` advertises `STRICT_REQUIRED_FOR` instead of the lax sandbox capability. Request-signing is a transport-layer property, not specialism-specific, so the strict route doesn't need v6 platform dispatch — one handler shared across all six tenants. The default `/<tenant>/mcp` continues to serve the v6 framework with sandbox signing (presence-gated, no required_for enforcement).

Strict authenticator composition rebuilds two enforcement gates the migration dropped:

- `requireSignatureWhenPresent` with `requiredFor: STRICT_REQUIRED_FOR` + `mcpToolNameResolver` so unsigned `create_media_buy` calls surface `request_signature_required` (vector 001) instead of admitting bearer.
- `enforceSigningWhenWebhookAuthPresent` wrapper so unsigned webhook-registration carrying `push_notification_config.authentication` fires the same error code (vector 027) — bearer-bypass is the exact downgrade this rule prevents.

Each route owns its own `InMemoryReplayStore` (#3338) — sharing one store lets a nonce consumed on `/mcp` falsely fire `request_signature_replayed` on `/mcp-strict`.

Floors ratchet to capture the conformance lift:

| Tenant            | Old (post-#4052) | New (with strict) | Delta |
|-------------------|------------------|-------------------|-------|
| /signals          | 65 / 23          | 66 / 54           | +1 / +31 |
| /sales            | 64 / 217         | 64 / 248          | flat / +31 |
| /governance       | 65 / 70          | 65 / 101          | flat / +31 |
| /creative         | 66 / 83          | 66 / 114          | flat / +31 |
| /creative-builder | 60 / 65          | 60 / 96           | flat / +31 |
| /brand            | 66 / 14          | 66 / 45           | flat / +31 |

Files: `server/src/training-agent/index.ts` (strict authenticator + per-tenant mount), `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.

Closes #3965 Class C. The full #3965 cluster is now closed: A (6.9.0 / adcp-client#1455), B (in-tree), C (this PR), D (in-tree), E (6.9.0 / adcp-client#1477), F (in-tree), G (phantom).
