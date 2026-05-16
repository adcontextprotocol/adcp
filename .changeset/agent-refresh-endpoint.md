---
---

Add `POST /api/registry/agents/{encodedUrl}/refresh` plus a "Refresh registry" button on each card in `/dashboard/agents` so an agent's owner (or an AAO admin) can re-probe the agent on demand and pull fresh `agent_health_snapshot` (online, tools_count, response_time_ms) and `agent_capabilities_snapshot` (inferred type, discovered tools) rows without waiting for the 60-min periodic crawl. Inline result on the card flashes the new online/tools/type so the owner sees what the public registry will display.

Auth: owner-of-record via `member_profiles.agents` membership, or `isWebUserAAOAdmin`. Rate-limited to 5 minutes per agent URL and 30 requests per user per hour. Synchronous — returns 200 with the new snapshot on success, 502 on probe failure (timeout / DNS / OAuth wall), 409 when monitoring is paused.

Closes the gap that previously forced operators to either wait for the periodic crawl or hit the unauthenticated full-fan-out `/api/crawler/run`. That endpoint and its sibling `/api/capabilities/discover-all` are now `requireAuth + requireAdmin`-gated; both amplify a single POST into outbound traffic against every registered agent.

The probe path mirrors the per-agent block of `CrawlerService.refreshAgentSnapshots`: same 10s timeout, same type-promotion policy (only promote when stored type is `unknown`; disagreement is logged to `type_reclassification_log` without auto-flipping, per #3538).
