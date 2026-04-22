---
---

fix(mcp): tolerate invalid BASE_URL values instead of crashing at startup (closes #2837)

`server/src/mcp/routes.ts` captured `MCP_SERVER_URL` at module-load time from `process.env.BASE_URL || 'http://localhost:…'`, then stripped a trailing slash. If the surrounding shell had `BASE_URL="/"` (the default in some deployment environments — conductor dev workspaces, certain container orchestrators), the `||` guard passed, the slash-strip produced `""`, and `new URL('')` inside `mcpAuthRouter` setup threw `TypeError: Invalid URL`. The server never started.

Replaced the inline computation with an exported `resolveMCPServerURL()` helper that validates the env value via the WHATWG URL constructor before using it, and falls through to the `http://localhost:{PORT}` default whenever the value is absent, whitespace-only, just `/`, or otherwise unparseable. Any operator that actually set `BASE_URL` to a valid URL is still authoritative.

Logs a warn when a set-but-invalid value is rejected, so the operator sees it:
```
BASE_URL is set but does not parse as a URL — falling back to the development default
```

**Test coverage (+11 unit tests):** `server/tests/unit/mcp-resolve-base-url.test.ts` asserts on valid-URL passthrough (trailing-slash strip), all four invalid-shape fallback paths (unset / empty / `/` / whitespace / non-URL string), PORT vs CONDUCTOR_PORT precedence, and a regression guard that the resolved URL always parses cleanly regardless of input.

**Downstream cleanup:** removes the `vi.hoisted()` workaround added in [#2833](https://github.com/adcontextprotocol/adcp/pull/2833) — integration tests no longer need a per-file BASE_URL guard since the server tolerates bad env gracefully. Verified by running `BASE_URL=/ npx vitest run server/tests/integration/registry-api-oauth.test.ts` — 17/17 still pass.
