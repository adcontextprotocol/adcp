---
---

Registry: collapse to a registered-only public surface (#3772).

`/api/registry/agents` and `/api/registry/publishers` now contain only AAO-attested, member-enrolled agents and publishers. Crawler-discovered entries from `adagents.json` no longer surface in the catalog — they continue to populate the publisher-authorization graph backing `lookupDomain`, `hasValidAdagents`, and `getSalesAgentsClaimingDomain`, but that graph is internal.

**Breaking change for callers reading the public registry surface.** External consumers of the following fields/params will need updates on this release:

- `source: 'registered' | 'discovered'` on FederatedAgent / FederatedPublisher / DomainLookupResult — removed
- `discovered_from` — removed
- `endorsed_by_publisher_member` — removed
- `discovered_at` — removed
- `sources: { registered, discovered }` count blocks on `/api/registry/agents` and `/api/registry/publishers` — removed
- `?source=` query param on `/api/registry/agents` — now returns 400 `{ error: "source query parameter is no longer supported (registry surface is registered-only)" }` instead of being silently dropped. Shape matches existing `/api/registry/*` 400 convention.
- `added_date` on `/api/registry/agents` items is now omitted instead of stamped with `today`. The field has always been optional in the OpenAPI schema; the previous fallback value was meaningless for member-enrolled agents (no real enrollment-date source on the wire). Consumers reading `added_date` should treat it as optional.

**Out of scope:** the `discovered_agents` / `discovered_publishers` tables and their drop-migration are deferred to a follow-up PR — tracked under #3772 (PR 3 of the 4-PR migration plan in that issue). The tables continue to back the publisher-authorization graph internally until then.

**Docs:** `docs/registry/registering-an-agent.mdx` is rewritten to describe the single enrollment path (no longer "four crawl paths" or two trust levels). `docs/registry/index.mdx` drops the stale `source` / `discovered` framing on `/api/registry/agents` and clarifies that the `agent.discovered` change-feed event represents an authorization-graph addition, not a catalog entry.

Closes #3772.
