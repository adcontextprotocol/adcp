---
---

Fix main's typecheck after #2800 (OAuth 2.0 client-credentials for Test-your-agent). `@adcp/client`'s `ComplyOptions.auth` / `TestOptions.auth` unions only accept `bearer | basic | oauth`; PR #2800 added an `oauth_client_credentials` variant to the server's `ResolvedOwnerAuth` and passed it straight through to the SDK, producing four type errors in `compliance-heartbeat.ts` and `registry-api.ts` and — at runtime — silently breaking the compliance check for any agent saved with client-credentials (the SDK has no handler for that variant).

Added a server-side RFC 6749 §4.4 exchange (`oauth-client-credentials-exchange.ts`) plus a narrowing adapter (`sdk-auth-adapter.ts`) that resolves `$ENV:ADCP_OAUTH_<NAME>` references, POSTs to the token endpoint with either HTTP Basic or form-body credentials, and hands the SDK a `{type:'bearer', token}` it already understands. Failed exchanges fall back to unauthenticated requests with a warn log rather than silently hanging or leaking the provider's error body.

No caching yet — compliance heartbeat and the test-your-agent paths are low-frequency, so re-exchanging per call is fine. When @adcp/client learns native client-credentials support with 401-triggered refresh, delete the bridge and pass the configs straight through.

Test coverage: 19 unit tests for the exchange logic (env resolution, basic vs body auth methods, scope/resource/audience passthrough, HTTP failures, non-JSON responses, missing access_token, network exceptions) plus the adapter narrowing path.
