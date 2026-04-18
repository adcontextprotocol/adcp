---
---

Enable OAuth 2.1 validation on the training agent (test-agent.adcontextprotocol.org).

Previously the training agent advertised OAuth via `.well-known/oauth-protected-resource/mcp` but only accepted static tokens and AAO API keys — any WorkOS-issued OAuth access token fell through to a 401, blocking storyboard runs and compliance tests from SDK consumers who authenticate via OAuth.

Changes:
- `requireToken` adds a fourth branch that validates WorkOS OAuth JWTs via the main app's `createOAuthProvider()` + the MCP SDK's `requireBearerAuth`.
- Serves a host-aware `.well-known/oauth-protected-resource/mcp` advertising the correct resource URL (`https://test-agent.adcontextprotocol.org/mcp`) and AAO as the authorization server.
- Sets `WWW-Authenticate: Bearer realm="test-agent", resource_metadata="..."` on all 401 responses (RFC 6750 §3).
- Exposes `WWW-Authenticate` via `Access-Control-Expose-Headers` and hoists CORS to a top-level middleware so browser MCP clients can read the challenge.
- Rate limiter now keys on authenticated subject (`req.auth.extra.sub` / `clientId`) with IP fallback, preventing a single OAuth user from dodging the cap via rotating IPs.
