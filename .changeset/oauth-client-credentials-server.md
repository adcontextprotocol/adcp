---
---

feat(compliance): persist OAuth 2.0 client-credentials auth for Test-your-agent flow (RFC 6749 §4.4)

Closes the server leg of [#2761](https://github.com/adcontextprotocol/adcp/issues/2761) — storyboard endpoints now resolve machine-to-machine OAuth credentials from `agent_context` and hand the SDK the [`oauth_client_credentials`](https://github.com/adcontextprotocol/adcp-client/pull/746) shape it shipped in `@adcp/client` 5.9.0. Complements the authorization-code path landed by #2738.

- **Migration** `419_oauth_client_credentials.sql` — new `oauth_cc_token_endpoint` / `oauth_cc_client_id` / `oauth_cc_client_secret_*` / `oauth_cc_scope` / `oauth_cc_resource` / `oauth_cc_audience` / `oauth_cc_auth_method` columns on `agent_contexts`. Client secret AES-256-GCM encrypted via the existing `encryption.ts` (same pattern as the auth-code path). `agent_context_summary` view surfaces a derived `has_oauth_client_credentials` flag.
- **DB layer** — `AgentContextDatabase.saveOAuthClientCredentials` / `getOAuthClientCredentialsByOrgAndUrl` / `removeOAuthClientCredentials`. New `OAuthClientCredentials` interface mirrors the SDK's `AgentOAuthClientCredentials` exactly (`auth_method: 'basic' | 'body'`, optional `scope` / `resource` / `audience`). `AgentContext.has_oauth_client_credentials: boolean` on every read path.
- **Resolvers** — `ResolvedOwnerAuth` union gains the `{ type: 'oauth_client_credentials', credentials, tokens? }` variant. Both `ComplianceDatabase.resolveOwnerAuth` (used by the compliance heartbeat cron) and the `resolveUserAgentAuth` helper behind the four Test-your-agent endpoints read the new columns and emit the shape the SDK consumes. Precedence: static bearer/basic > auth-code OAuth with refresh > client-credentials > raw bearer fallback. Only one of these will be set for any given agent in practice; the ordering is for the edge case.
- **New endpoint** `PUT /api/registry/agents/{encodedUrl}/oauth-client-credentials` — validates `token_endpoint` via the same SSRF-resistant helper that gates agent URLs (HTTPS-only in production, cloud-metadata + private-IP blocked), persists via the new DB method. Same ownership check as `/connect`.
- **Addie tool** — `save_agent` accepts an `oauth_client_credentials` object alongside `auth_token`. Handler validates the blob shape, short-circuits on bad URLs / missing fields with user-visible strings (the caller is an LLM — raw exceptions summarize poorly), then persists.
- **OpenAPI** — full schema for the new endpoint registered; `AgentAuthStatusSchema` extended with `has_oauth_client_credentials` flag and the `oauth_client_credentials` auth-type value.

`$ENV:VAR_NAME` references in `client_id` / `client_secret` are stored as-written — the SDK resolves at exchange time, so no on-disk plaintext for operators who wire secrets through environment variables.

Dashboard UI form for configuring client-credentials is intentionally not in this PR — tracked as a separate follow-up. This change is end-to-end testable via the `save_agent` Addie tool or a direct PUT to the endpoint.

## Test plan

- [x] `npm run typecheck` clean
- [x] 29 unit tests across `compliance-db-resolve-owner-auth.test.ts` + `resolve-user-agent-auth.test.ts` covering every branch of the extended resolvers: client-credentials with all optional fields, with only required fields, with an invalid `auth_method` value (defensive-ignore), precedence vs auth-code OAuth, flag-vs-row divergence
- [x] Full server unit suite: 1728 passed / 34 skipped / 0 failed
- [x] OpenAPI coverage test passes (new endpoint registered with full request/response schemas)
- [ ] Integration smoke test against a real authorization server — follow-up, not blocking
