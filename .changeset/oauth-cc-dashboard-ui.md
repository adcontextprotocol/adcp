---
---

feat(dashboard): OAuth client-credentials form on the agent compliance page

Closes the UI leg of [#2761](https://github.com/adcontextprotocol/adcp/issues/2761). Completes the server-side work in [#2800](https://github.com/adcontextprotocol/adcp/pull/2800).

Adds a third option to the existing Auth-type select on `dashboard-agents.html` — "OAuth client credentials (machine-to-machine)" — alongside the existing OAuth (authorization-code) and bearer/basic options. Selecting it reveals fields for:

- `token_endpoint` (URL, required, validated server-side for SSRF)
- `client_id`, `client_secret` (required; both accept `$ENV:ADCP_OAUTH_<NAME>` references that the SDK resolves at exchange time)
- `scope`, `resource`, `audience` (optional)
- `auth_method` select (basic = HTTP Basic header, or body = form fields)

Submit calls `PUT /api/registry/agents/:encodedUrl/oauth-client-credentials` (shipped in #2800), validates through the shared `parseOAuthClientCredentialsInput` server-side, and persists encrypted. The "Auth configured" label distinguishes `oauth_client_credentials` from plain OAuth in the post-save state.

## Test plan

- [x] Isolated Playwright test — 16/16 assertions pass: form renders, select has the new option, toggle shows the correct field group, PUT fires with the correctly-encoded URL and full JSON body, empty optionals omitted, success state replaces the form
- [x] JS in the HTML parses cleanly
- [x] Typecheck clean
- [ ] In-browser validation against a running dev server (requires WorkOS / PG / encryption secret — recommended before merge)
