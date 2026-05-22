---
---

fix(crawler): register adagents.json-discovered agents into the periodic probe and per-agent crawl set (#4849).

Three gaps closed:

1. `refreshAgentSnapshots` now includes all `discovered_agents` table rows (not just member-profile agents), so agents recorded via `recordAgentFromAdagentsJson` get their capability/health snapshots refreshed and their `agent_type` promoted on the first crawl cycle that discovers them.

2. `crawlAllAgents` now merges DB-discovered sales agents (type already promoted in a prior cycle) into the initial `PropertyCrawler.crawlAgents()` call so their `list_authorized_properties` is fetched and their claimed publisher domains enter the in-memory `PropertyIndex`.

3. `populateFederatedIndex` gains a step 2b that walks DB-discovered sales agents through the same publisher-domain crawl loop as config-seeded agents, using the now-populated `PropertyIndex`.

`FederatedIndexService` gains a thin `listDiscoveredAgents()` accessor that exposes `discovered_agents` rows to the crawler without leaking the DB layer. Rate-limiting is inherited from the existing `CONCURRENCY=5` probe batcher and the `PropertyCrawler`'s built-in concurrency controls; no new scheduling surface introduced.
