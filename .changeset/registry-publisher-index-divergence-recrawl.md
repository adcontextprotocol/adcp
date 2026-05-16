---
---

`/api/registry/publisher` now detects when the cached origin manifest in `publishers.adagents_json` declares an `authorized_agents` URL that the federated index doesn't carry, and triggers a re-crawl on visit when the row is older than the auto-crawl bypass window. This recovers from the wonderstruck-shaped failure where a per-agent upsert silently fails (or the publisher adds an agent after the cache was last written) and an anonymous visitor's view stays stuck on a stale agent list. Gated on `last_validated >1h` so an in-flight crawl isn't preempted.
