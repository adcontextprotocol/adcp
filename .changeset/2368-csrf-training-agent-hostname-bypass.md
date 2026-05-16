---
"adcontextprotocol": patch
---

Fix: CSRF middleware now exempts the per-tenant training-agent MCP route shape (`/<tenant>/mcp[-strict[-required|-forbidden]]`). Without this, requests to those routes — mounted at root via host-based dispatch on `test-agent.adcontextprotocol.org` — returned 403 `csrf_token_mismatch` before reaching the verifier, even for unsigned negative vectors that should have surfaced `request_signature_required`. The existing path-based exemption list only matched the legacy single-URL shape (`/mcp-strict`) and the AAO mount prefix (`/api/training-agent/`), missing the per-tenant URLs introduced when the strict routes moved to `/<tenant>/mcp-strict`.

Pattern-matched on path shape rather than hostname because `req.hostname` is derived from `X-Forwarded-Host` under `trust proxy = 1`, which Fly's edge forwards as-received from the client. A hostname-based bypass would have let an attacker spoof `X-Forwarded-Host: test-agent.adcontextprotocol.org` on a cookie-authenticated route and skip CSRF. Path shape isn't client-spoofable.

Unblocks `adcp grade request-signing https://test-agent.adcontextprotocol.org/<tenant>/mcp-strict` against the live test agent. Closes adcp#2368.
