---
---

test(integration): end-to-end supertest harness for registry-api OAuth credential endpoints (closes #2806)

Extends the existing supertest pattern (admin-endpoints.test.ts) to the registry-api OAuth credential surface. Closes the route-level coverage gap identified in #2806 for OAuth credential-save — SSRF gates, ownership checks, error-response shape, and the save → auth-status → test-exchange flow are now exercised end-to-end against a real Postgres.

**Scope (17 test cases):**

- `PUT /connect` — bearer save, context-only (no auth_token), 403 on non-owner, 400 on bad auth_type.
- `PUT /oauth-client-credentials` — valid save, full config persistence (optional fields round-trip through `agent_contexts`), SSRF-block on cloud-metadata host, `$ENV:` allowlist enforcement, missing-field rejection, 403 on non-owner.
- `POST /oauth-client-credentials/test` — 404 when no creds saved, `{ok: true, latency_ms}` on clean exchange (SDK mocked), typed `ClientCredentialsExchangeError` plumbed through to `{ok: false, error: {kind, oauth_error, http_status}}`, 403 on non-owner.
- `GET /auth-status` — no-auth baseline, reports static `bearer` after connect, reports `oauth_client_credentials` after cc save.

**Infrastructure touches:**

- `server/tests/setup/revenue-tracking-env.ts` now sets `BASE_URL=http://localhost:3000`. Without it, the MCP router's `new URL(MCP_SERVER_URL)` at HTTPServer construction throws when the surrounding env has `BASE_URL="/"` (a conductor-workspace default that passes the `||` guard but strips to `""` after `.replace(/\/$/, '')`).

**Run locally:**

```
DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
  npx vitest run --config server/vitest.config.ts \
  server/tests/integration/registry-api-oauth.test.ts
```

Requires a Postgres reachable at `DATABASE_URL` — same pattern as the other integration tests. Not added to CI; follows the repo's existing convention that integration tests run manually.

**Assertions intentionally loose on error shape:** #2828 adds structured `{code, field}` to save-endpoint rejections but hasn't merged yet. The integration tests assert on error-string content only (e.g. `expect(res.body.error).toMatch(/\$ENV/)`). When #2828 lands, those can be tightened in a follow-up.
