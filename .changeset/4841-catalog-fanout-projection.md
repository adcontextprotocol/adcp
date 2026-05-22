---
---

feat(catalog): project publisher_properties fan-out into catalog_agent_authorizations so partner-sync endpoints see manager-asserted children (#4841)

Closes the gap surfaced after PR #4840 landed fan-out writes in the legacy `agent_publisher_authorizations` arm: the catalog projection in `publisher-db.ts:upsertAdagentsCache` deliberately refuses cross-publisher claims (line 968: "publisher_properties claims a different publisher — cross-publisher refused"). Result: ~6,800 cafemedia child authorization edges existed in the legacy arm but never landed in `catalog_agent_authorizations`. The auth-gated partner-sync endpoints (`/registry/authorizations`, `/registry/authorizations/snapshot`) read the catalog only and missed all of them.

## Design

The existing guard is load-bearing for catalog trust — a hostile manager file can't project authoritative rows for publishers that didn't authorize anything. The guard stays. Instead, the fan-out gets its **own evidence value** so the projection is explicit and consumers can filter:

- **New evidence value `adagents_authoritative`** (migration 488) — distinct from `adagents_json`. Trust profile is lower (manager-asserted, no bilateral confirmation from the publisher's own origin). Per the inline-resolution rule (#4825), the manager file naming the publisher in `publisher_properties[].publisher_domains[]` is the out-of-band corroboration that makes the projection safe.
- **New writer** `PublisherDatabase.recordCatalogFanoutAuthorization({ agentUrl, childDomain, authorizedFor? })` — INSERT-or-UPDATE into `catalog_agent_authorizations` with `evidence='adagents_authoritative'`, `created_by='system'`, no `property_rid` (publisher-wide row).
- **Crawler hook** — fan-out helper in `crawler.ts:fanOutPublisherPropertiesAuthorizations` calls the new writer per (agent, child) pair, alongside the existing `recordChildPublisherFromManager` (publishers row) and `recordAgentFromAdagentsJson` (legacy authz row).
- **Backfill** — migration 488 inserts catalog rows for every existing fan-out edge (`SELECT ... FROM publishers JOIN agent_publisher_authorizations WHERE discovery_method='adagents_authoritative'`). Idempotent — `ON CONFLICT DO NOTHING`.
- **Evidence-to-source mapping** — the 6 sites in `federated-index-db.ts` that map `v.evidence → source` add `WHEN 'adagents_authoritative' THEN 'adagents_json'` so the legacy `source` field round-trips through the catalog dual-read path correctly.

## What partner-sync consumers see after this lands

`/registry/authorizations?agent_url=https://interchange.io` now returns ~6,800 rows (the cafemedia children), each with `evidence: 'adagents_authoritative'`. Consumers that want bilateral-confirmed-only can filter `evidence=adagents_json`; consumers that want the full picture take both.

The directory inverse-lookup endpoint (#4838) is unchanged — it was already returning these via the legacy-arm union. This PR brings the catalog-only consumers up to parity.

## Tests

- Catalog row shape (evidence, created_by, publisher_domain, property_rid=null)
- Idempotent re-write
- Coexists with an `adagents_json` row for the same (agent, publisher) without conflict
- Silent-skip on invalid agent_url
- Canonicalization
- Appears in `v_effective_agent_authorizations` with evidence preserved
