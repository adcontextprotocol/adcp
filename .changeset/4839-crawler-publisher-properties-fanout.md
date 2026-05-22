---
---

feat(crawler): fan publisher_properties[].publisher_domains[] into per-child authorization rows so the AAO directory inverse-lookup (adcp#4823) returns one row per represented publisher, not one row per manager file.

**Why.** With the directory endpoint (#4838) and resolution rule (#4827) merged, the cafemedia case still returns one cafemedia.com row with `properties_authorized = 0` and `properties_total = 0` — the 6,800 represented publishers stay invisible. Tracing the crawler showed that `authorization_type: publisher_properties` writes only the manager-host edge to `agent_publisher_authorizations`; the child publisher_domains[] selector is never expanded. This PR closes that gap.

**What changes.**

1. **Migration 486** (`server/src/db/migrations/486_publisher_discovery_method_adagents_authoritative.sql`). Adds `'adagents_authoritative'` to `publishers.discovery_method` CHECK constraint. Migration 470's three values (`direct`, `authoritative_location`, `ads_txt_managerdomain`) cover paths where the publisher's own origin was fetched. The fourth value covers paths where the publisher is named only in the manager file's inline properties — the inline-resolution shape the spec endorsed in #4827.

2. **DiscoveryMethod type** (`server/src/adagents-manager.ts`, `server/src/db/federated-index-db.ts`). TS union widened to four values. Endpoint at `/api/v1/agents/{agent_url}/publishers` (shipped in #4838) already accepted the fourth value in its OpenAPI/JSON-Schema; this PR makes it emittable.

3. **`PublisherDatabase.recordChildPublisherFromManager`** (`server/src/db/publisher-db.ts`). Upserts a `publishers` row keyed on the child domain with `source_type='community'`, `discovery_method='adagents_authoritative'`, `manager_domain=<host>`, and NO `adagents_json` blob — the child's own origin was never fetched. Critically: if a stronger row already exists (the child was independently crawled and has its own blob + `direct` discovery), the upsert preserves it. Direct crawl wins over manager-file attribution.

4. **`CrawlerService.fanOutPublisherPropertiesAuthorizations`** (`server/src/crawler.ts`). Walks each `authorized_agents[]` entry whose `authorization_type` is `publisher_properties` and, for each selector's `publisher_domain` / `publisher_domains[]` value, writes per-child rows in both `publishers` and `agent_publisher_authorizations`. Idempotent (relies on the existing unique constraints + ON CONFLICT semantics). Per-child failures are logged but do not abort the rest — partial progress beats silent total failure on a 6,800-domain network. Called from both crawler loops (per-discovered-publisher at L457 and per-agent-claimed-publisher at L542) so cafemedia is covered regardless of which discovery path landed it.

**What it produces on cafemedia.com.** Before: 1 row in `agent_publisher_authorizations` (interchange.io → cafemedia.com), 0 child rows. After: 1 row for cafemedia.com (host) + 6,800 rows for child publishers (each with `source='adagents_json'`, sharing the agent_url `https://interchange.io`), 6,800 rows in `publishers` with `discovery_method='adagents_authoritative'` and `manager_domain='cafemedia.com'`. The directory endpoint then returns 6,800 publisher rows with correct `properties_authorized` / `properties_total` per-publisher counts (since `discovered_properties.publisher_domain` already carries the right child value via the existing `recordPropertiesForAgent` flow).

**Trust profile of `adagents_authoritative`.** Medium — the manager file names each represented publisher on each property's `publisher_domain` field (the same anchor the [`managerdomain` fallback safety rule](https://adcontextprotocol.org/docs/governance/property/adagents#safety-rules-for-this-fallback) requires), but no bilateral confirmation from the publisher's own origin. Distinct from `direct` (origin-fetched), `authoritative_location` (publisher actively delegated), and `ads_txt_managerdomain` (delegation discovered via ads.txt fallback).

**Out of scope.**
- Per-child crawl of the 6,800 represented domains. Inline resolution from the manager file is sufficient by spec; per-child crawl is an optional escalation a directory operator MAY do, separate concern.
- Revocation propagation through fan-out. The host's `revoked_publisher_domains[]` already short-circuits the directory's status emission via the existing JSONB walk on the host row; per-child revocation when a child is later crawled directly is preserved by the "direct wins" upsert rule.
