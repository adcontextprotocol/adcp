---
---

feat(registry): persist managerdomain discovery provenance on publisher rows

Adds `discovery_method` and `manager_domain` columns to the `publishers`
table (migration 470) and threads provenance through all crawler write
paths (`cacheAdagentsManifest`, events). Both fields are now surfaced in
the `/api/validate-publisher` response and `/api/registry/publisher`
endpoint so callers can distinguish direct origin-attestation from
one-hop ads.txt `MANAGERDOMAIN` delegation.

Events `publisher.adagents_discovered` and `publisher.adagents_changed`
now carry `discovery_method` and `manager_domain` in their payloads.

Non-protocol change (server infrastructure only). Follow-up: reverse
index + fan-out (issue #4200 item 2), per-agent `source` enum extension
to `adagents_json_via_manager`.
