---
---

Accept OAuth-issued user JWTs at `/api/*`, closing the gap between what the OpenAPI spec advertised and what the server enforced.

The MCP OAuth flow (`mcpAuthRouter` at `/authorize` → AuthKit → `/token`) already issued WorkOS-signed JWTs and verified them on `/mcp`. REST's `requireAuth` only accepted sealed-session cookies and `sk_...` organization API keys — so an agent client that SSO'd a user had no way to call the REST API on that user's behalf, even though the spec said `bearerAuth` was accepted.

**What's new**

- `requireAuth` accepts WorkOS-signed user JWTs via `Authorization: Bearer <jwt>`. Same verifier the MCP OAuth flow uses (WorkOS JWKS). Subject must correspond to a real local user. Machine-to-machine tokens (`client_credentials`) are rejected here — server-to-server callers continue to use `sk_...` keys.
- RFC 9728 protected-resource metadata is now published at `GET /.well-known/oauth-protected-resource/api`, pointing at the same authorization server as `/mcp`. A single user SSO grants both surfaces.
- `scripts/generate-openapi.ts` now registers the `bearerAuth` and `oauth2` security schemes on the registry (passing them via `generateDocument` options was silently dropped by `OpenApiGeneratorV31`). The checked-in spec had `security: [{ bearerAuth: [] }]` on 24 endpoints referencing a scheme the spec never defined — codegen would have broken. Each protected endpoint now lists both schemes as alternatives.
- `docs/registry/index.mdx` gains an "Option B: User SSO via OAuth 2.1" section covering the discovery endpoints and flow.

**Incidental fix — MCP OAuth user upsert**

`handleMCPOAuthCallback` did not upsert the authenticated user into the local `users` table, while the cookie-based `/auth/callback` path did. MCP tool handlers never noticed because they read claims straight off `req.mcpAuth`. REST `requireAuth` verifies the JWT subject corresponds to a real local user, so users who first arrived via MCP were rejected at `/api/*`. The callback now performs the same upsert the cookie path does (`server/src/mcp/oauth-provider.ts`).

**Security hardening from review**

- **Application pinning.** `verifyWorkOSJWT` now rejects tokens whose `azp` or `client_id` claim is not our own `WORKOS_CLIENT_ID`. Without this, a sibling application in the same WorkOS tenant could mint tokens that pass signature verification against the shared JWKS.
- **Positive cache on the JWT branch.** `validateWorkOSBearerJWT` caches successful validations keyed on SHA-256 of the token, TTL `min(60s, remaining token exp)`. Removes the per-request DB round-trip that would otherwise amplify DoS surface vs the cookie path (which has an equivalent cache).
- **Trust scoping.** Dropped the auto-`isMember = true` assignment from the JWT's `org_id` claim — the claim reflects the AuthKit-selected org, not AAO membership. Downstream `enrichUserWithMembership` resolves real standing via the DB.
- **Error surface.** MCP `InvalidTokenError` now returns a fixed `"Invalid or expired token"` message instead of echoing `jose` internals. Real error is logged server-side.
- **Test coverage.** `__setJWKSForTesting` hook lets us exercise `verifyWorkOSJWT` with locally-generated key pairs — added coverage for happy path, expired tokens, signature-from-unknown-key, `azp`/`client_id` mismatch, missing application id, and M2M detection.

**Scope of writes**

User JWTs get the same access as organization API keys — writes included. MCP tool handlers already allowed OAuth users to mutate registry state; restricting REST to reads would have been arbitrary inconsistency.

**Files**

- New: `server/src/auth/workos-jwt.ts` (shared verifier), `server/tests/unit/workos-jwt.test.ts`
- Changed: `server/src/middleware/auth.ts`, `server/src/mcp/oauth-provider.ts`, `server/src/http.ts`, `server/src/mcp/index.ts`, `server/src/routes/registry-api.ts`, `scripts/generate-openapi.ts`, `static/openapi/registry.yaml`, `docs/registry/index.mdx`
