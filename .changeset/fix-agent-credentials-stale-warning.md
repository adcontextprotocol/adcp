---
---

Fix: "Agent requires authentication" warning no longer persists after an owner saves credentials.

The warning is driven by the crawler's `oauth_required` flag, which was set by an unauthenticated probe and never invalidated when an owner saved an auth token / OAuth credentials. The periodic heartbeat — also unauthenticated — kept re-asserting the flag, so the warning could survive indefinitely even when the saved credentials were perfectly valid.

Three coordinated changes:

1. **`PUT /api/registry/agents/{encodedUrl}/connect`** now auto-runs an authenticated `crawler.refreshSingleAgent` immediately after `saveAuthToken`. The success path returns the fresh probe result so the dashboard reload reflects current compliance state — no waiting for the next heartbeat cycle. Refresh failures log a warning but do not fail the save (credentials persist either way).

2. **`PUT /api/registry/agents/{encodedUrl}/oauth-client-credentials`** mirrors the same auto-refresh after `saveOAuthClientCredentials`.

3. **`CrawlerService.refreshAgentSnapshots`** (the periodic crawl) now resolves any org's saved credentials per agent via the new `AgentContextDatabase.findOrgWithSavedAuth(agentUrl)` and threads them into `discoverCapabilities`, `checkHealth`, and `getStats`. Agents with no registered credentials still probe anonymously. When multiple orgs have registered the same agent, the most recently updated credential set wins (matches "freshly-rotated creds take precedence"; the snapshot is one shared row).

Existing stuck users do not need to re-authenticate. After deploy, either (a) clicking Refresh on the agent card, or (b) waiting for the next periodic heartbeat will clear the flag using the credentials already on file. Saves performed after deploy clear the warning synchronously.

The dashboard's connect-form success message updates from "Compliance check will run on the next heartbeat cycle" to "Connected and re-checked" to match the new synchronous behavior.
