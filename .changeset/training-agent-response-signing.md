---
---

feat(training-agent): RFC 9421 sign outbound MCP responses

Every successful JSON response from a tenant MCP route (`/api/training-agent/<tenant>/mcp` and the strict variants) now carries RFC 9421 `Signature`, `Signature-Input`, and `Content-Digest` headers. Signed with a new per-tenant Ed25519 keypair marked `adcp_use: "response-signing"` — distinct from the existing webhook-signing material per the `adcp_use` distinct-keys-per-purpose invariant the SDK enforces.

The response-signing JWK appears in the shared `/.well-known/jwks.json` discovery document; buyer verifiers filter by `adcp_use` and `kid` to find the right one. The JWKS endpoint now aggregates every signing purpose the training agent publishes (shared webhook + per-tenant webhook + per-tenant response + governance).

Unblocks step 1 of the seller-verification walkthrough (`docs/verification/overview`) being demoable against the training agent: a buyer client fetching `https://test-agent.adcontextprotocol.org/api/training-agent/sales/mcp` now receives a signed response whose `keyid` resolves via `agents[].jwks_uri` in `brand.json`.

Implementation notes:

- The `wrapResponseForSigning` middleware buffers writes from the MCP transport (`StreamableHTTPServerTransport` with `enableJsonResponse: true`) and intercepts `res.writeHead` so signing headers can be set before the response commits. Non-2xx and non-JSON responses (SSE, errors) pass through unsigned.
- Per-tenant response-signing material is pre-warmed at router-create time so the JWKS includes every tenant's key from the first request, not only after each tenant has been touched.
- Built on `@adcp/sdk@^7.7.0` which ships `signResponse` / `signResponseAsync` from [adcp-client#1823](https://github.com/adcontextprotocol/adcp-client/pull/1823).

Bumps `@adcp/sdk` from `^7.6.0` to `^7.7.0`.
