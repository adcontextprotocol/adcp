---
"adcontextprotocol": patch
---

Fix: CSRF middleware now bypasses validation for requests on the dedicated training-agent hostname (`test-agent.adcontextprotocol.org`). Without this, per-tenant routes mounted at root via host-based dispatch (e.g. `/sales/mcp-strict`, `/governance/mcp`) returned 403 `csrf_token_mismatch` before reaching the verifier — even for unsigned negative vectors that should have surfaced `request_signature_required`. The path-based `EXEMPT_EXACT` / `EXEMPT_PREFIXES` lists only matched the legacy single-URL shape (`/mcp-strict`) and the AAO mount prefix (`/api/training-agent/`), missing the per-tenant URLs introduced when the strict routes moved to `/<tenant>/mcp-strict`.

The training-agent host serves exclusively server-to-server traffic — every route under it authenticates via bearer token or RFC 9421 signature, never cookie-bound sessions — so CSRF protection had no work to do on that host. Hostname-based bypass mirrors the spirit of the existing exact-path entries (`/mcp`, `/mcp-strict`, `/mcp-strict-required`, `/mcp-strict-forbidden`) which were added for the same reason on the same host.

Unblocks `adcp grade request-signing https://test-agent.adcontextprotocol.org/<tenant>/mcp-strict` against the live test agent. Closes adcp#2368.
