---
---

Dashboard "Recheck" probe now sends the agent's saved auth token. Previously the probe path (`POST /api/registry/agents/:encodedUrl/refresh` → `crawler.refreshSingleAgent` → `capabilityDiscovery.discoverCapabilities` → `discoverMCPTools`) constructed the `AdCPClient` with no auth fields, so any agent gated behind a static bearer (or saved OAuth) returned 401 → wrapped as `AuthenticationRequiredError` → reported as "Offline · 0 tools · type unknown · OAuth required" — even when `evaluate_agent_quality` worked fine using the same saved token (escalation: Warren Fernandes / Media.net, agent at `seller-platform.aitools.access.mn/mcp`, hint `****8Txk`).

The route now resolves owner-org auth via the existing `resolveUserAgentAuth` + `adaptAuthForSdk` helpers and threads it through `refreshSingleAgent` → `discoverCapabilities`, `checkHealth`, `getStats` → SDK `AgentConfig.auth_token` / `headers` / `oauth_tokens` fields. A2A health probes (raw fetch to `/.well-known/agent.json`) gain the same `Authorization` header. The periodic crawl path stays unauthenticated by design (it scans the public federated index across all orgs).

When auth is provided, the discovery / health / formats caches are both read-bypassed (so a manual refresh sees fresh state) and write-bypassed (so an authed-discovered profile — which may include tools the agent only exposes behind credentials — never leaks into the shared cache that feeds unauthed periodic crawls and the public registry render).

OAuth client_credentials variants pre-exchange via the existing `adaptAuthForSdk` adapter and probe with the resulting bearer. Authorization-code OAuth (saved `oauth_tokens` + `oauth_client`) probes with the current access token; refresh-on-401 inside the probe is not wired because `oauth_client` doesn't carry a `token_endpoint`. If the saved token has expired, the owner re-authorizes via the existing OAuth flow and re-probes. Static bearer (the original report) works fully.
