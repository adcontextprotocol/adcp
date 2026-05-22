---
"adcontextprotocol": patch
---

Stop paging `#admin-errors` on expected per-agent / per-API failures.

- `/api/discover-agent` now classifies the discovery error via `classifyMCPError` and logs `unreachable` / `wrong_path` (e.g. stale `*.trycloudflare.com` tunnel URLs, agent advertising MCP at a non-standard path) at `warn` with a structured `kind` + actionable `message` in the 502 response. Only `unknown` kinds still escalate via `logger.error`. `TimeoutError` was already a separate branch and is now `warn` too, since it's a per-agent issue rather than a system fault.
- `lumaFetch` no longer logs `logger.error` on every non-2xx; it just throws. Every call site already logs on catch — `getEventHosts` deliberately at `debug` because hosts API access is best-effort — so 404s from `/event/get-hosts` (events the API key can't see) stop paging. The endpoint, status, and body are now included in the thrown message so callers' single error log still has them.
