---
---

The crawler now reconciles authorized-agent rows after every successful adagents.json fetch — agents that were in a prior crawl but are no longer in the freshly-fetched manifest get hard-deleted from the legacy `agent_publisher_authorizations` table and soft-deleted (`deleted_at`) from `catalog_agent_authorizations`. Both writers were upsert-only previously, which meant an agent removed from a publisher's `/.well-known/adagents.json` lingered in the federated index forever. `agent_claim` rows and rows attested by other writers (`evidence != 'adagents_json'`) are untouched — those belong to a different publisher's discovery flow and a removal from one manifest must not erase another's claims.
