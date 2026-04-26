# Registry Authorization Model

**Status**: Proposal — gating artifact for PR 4b of #3177

**Decision needed**: Where do agent → publisher / agent → property authorizations live in the catalog?

## TL;DR

Recommend **Option A: first-class `catalog_agent_authorizations` table**, mirroring `catalog_identifiers` (evidence / confidence / disputed). It's the only option that supports the dominant query patterns at indexed-lookup speed, integrates cleanly with the override layer that already shipped (`adagents_authorization_overrides`), and unifies the two parallel legacy tables (`agent_property_authorizations` + `agent_publisher_authorizations`) into one.

The other two options either sacrifice query performance (Option B: read JSONB on every call) or pay structural cost for flexibility we don't need (Option C: store auth as `catalog_facts`).

## Context

The unification (#3177) collapses two parallel registries — `discovered_properties` (legacy crawl output) and `catalog_properties` (fact-graph) — into one. Property identity moved cleanly: PR 1 shipped the `publishers` cache, PR 2 the writer, PR 3 the test baseline, PR 4a the property-side reader cutover.

Authorization is the open question. Today there are two legacy tables:

```
agent_publisher_authorizations
  (agent_url, publisher_domain, authorized_for, property_ids[], source)
  source ∈ {adagents_json, agent_claim}

agent_property_authorizations
  (agent_url, property_id → discovered_properties.id, authorized_for)
```

Plus the override layer that already shipped in PR 1:

```
adagents_authorization_overrides
  (host_domain, agent_url_canonical, property_id, override_type, override_reason, ...)
```

The overrides table is keyed on `agent_url_canonical` and a publisher's `host_domain`. It assumes the *base* set of authorizations is canonical and well-keyed. Without a base table, every override application has to scan JSONB — which is the failure mode the override layer was designed to avoid.

## Query patterns to support

The PR 3 baseline tests pin the exact I/O of the readers PR 4b must preserve. Roughly:

1. **`getAgentsForDomain(domain)`** — all agents authorized for this publisher, with source label (`adagents_json` vs `agent_claim`). Public registry endpoint.
2. **`getDomainsForAgent(agent_url)`** — all publishers this agent represents.
3. **`getPropertiesForAgent(agent_url)`** — all properties this agent can sell, JOIN'd to property metadata.
4. **`findAgentsForPropertyIdentifier(type, value)`** — given a domain or bundle ID, who can sell it.
5. **`bulkGetFirstAuthForAgents(agent_urls[])`** — for a list of agents, return one auth row each, preferring `adagents_json` over `agent_claim`. Used by the listing endpoints.
6. **`validateAgentForProduct(agent_url, publisher_properties[])`** — coverage check for product offerings (`selection_type` ∈ `all` / `by_id` / `by_tag`).

All of these need to be indexed on at least `(agent_url)` and `(publisher_domain)` or `(property_rid)`. Five of the six have a single-key WHERE clause; one (`bulkGetFirstAuthForAgents`) is an `agent_url = ANY($1)` over a 1K-batch.

## Options

### Option A — First-class `catalog_agent_authorizations` table

```sql
CREATE TABLE catalog_agent_authorizations (
  id              UUID PRIMARY KEY,
  agent_url       TEXT NOT NULL,             -- canonical (lowercase, no trailing /)
  property_rid    UUID REFERENCES catalog_properties,  -- NULL = publisher-wide
  publisher_domain TEXT NOT NULL,            -- denormalized; equals 'adagents_json:<domain>'-derived
  authorized_for  TEXT,                       -- free-text scope from manifest
  property_ids    TEXT[],                     -- manifest property_id refs (when present)
  evidence        TEXT NOT NULL,              -- 'adagents_json' | 'agent_claim' | 'community'
  confidence      TEXT NOT NULL,              -- 'authoritative' | 'strong' | 'medium' | 'weak'
  disputed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- sync watermark
  deleted_at      TIMESTAMPTZ,                          -- soft-delete tombstone for delta consumers
  CONSTRAINT chk_caa_agent_url_canonical
    CHECK (agent_url = lower(agent_url) AND agent_url NOT LIKE '%/'),
  UNIQUE (agent_url, COALESCE(property_rid::text, ''), publisher_domain, evidence)
);
CREATE INDEX idx_caa_by_agent     ON catalog_agent_authorizations (agent_url);
CREATE INDEX idx_caa_by_publisher ON catalog_agent_authorizations (publisher_domain);
CREATE INDEX idx_caa_by_property  ON catalog_agent_authorizations (property_rid)
  WHERE property_rid IS NOT NULL;
CREATE INDEX idx_caa_sync         ON catalog_agent_authorizations (updated_at);
```

`updated_at` and `deleted_at` are not strictly required for the reader cutover but are load-bearing for agent-side sync (see "Agent-side sync" below). Including them in the initial schema avoids a follow-up migration once the snapshot/delta endpoints ship.

**Writer-side**: `cacheAdagentsManifest` extracts each `authorized_agents[]` entry from the manifest body and inserts one row per (agent, property) pair (with `property_rid` resolved from the property_id catalog lookup) plus one row per agent for the publisher-wide case. Same security guards as the existing `projectPropertyToCatalog` (cross-publisher refusal, anchor rule, etc.) — the hijack risk on agent claims is symmetric to the property-identifier case.

The buying-agent claim path (`recordPublisherFromAgent`, today writing `agent_publisher_authorizations` with `source='agent_claim'`) lands here as `evidence='agent_claim'`, `confidence='medium'`. The two source types live side by side in one table; readers filter or order by `evidence` as the legacy `source` field already encodes.

**Override-layer integration**: the effective authorization set is

```
catalog_agent_authorizations LEFT JOIN adagents_authorization_overrides
  ON ... matching keys, where superseded_at IS NULL
WHERE override_type = 'add'   → row surfaces
   OR override_type = 'suppress' AND no override matches
```

Implemented as a SQL VIEW (`v_effective_agent_authorizations`) so readers stay simple.

**Backfill**: one-time migration copies legacy rows into the new table. Both `agent_property_authorizations` (per-property) and `agent_publisher_authorizations` (per-publisher) flatten into the same shape. Legacy `source` field maps to `evidence`.

**Pros**
- Indexed lookups on every dominant query pattern. `getDomainsForAgent` is `WHERE agent_url = $1` — index hit.
- `bulkGetFirstAuthForAgents` is `WHERE agent_url = ANY($1)` with the existing index pattern.
- Symmetric with `catalog_identifiers` — readers reuse the same evidence/confidence vocabulary, dispute layer attaches naturally.
- Override layer keys are already designed for it — `agent_url_canonical` and `property_id` line up directly.
- Unifies the two legacy tables into one shape (NULL `property_rid` = publisher-wide).

**Cons**
- New schema migration (PR 4b-prereq).
- Writer extension: another projection step in `cacheAdagentsManifest`. Modest — same guards as the property projection, fewer fields to handle.
- Backfill needed before reader cutover.

### Option B — Read directly from `publishers.adagents_json` JSONB

No new table. Every authorization query unfolds JSONB:

```sql
-- getDomainsForAgent(agent_url):
SELECT DISTINCT p.domain
FROM publishers p
CROSS JOIN LATERAL jsonb_array_elements(p.adagents_json->'authorized_agents') AS auth
WHERE auth->>'url' = $1 AND p.source_type = 'adagents_json';
```

**Pros**
- No schema change. The manifest body is the source of truth — no synchronization concern.
- Override layer still applies as a SQL JOIN, same as Option A.

**Cons**
- **Every authorization query scans every publisher's manifest.** GIN indexes on JSONB don't help equality-on-extracted-text efficiently; an expression index on `(p.adagents_json->'authorized_agents')` is unwieldy and doesn't index well-suited paths.
- For `getDomainsForAgent` the reader is O(N publishers × M agents per publisher) per call. At 10K publishers averaging 5 authorized agents, that's a 50K-row scan to answer a question that's `WHERE agent_url = $1` in Option A.
- No room for `evidence='agent_claim'` (buying-agent assertions have no manifest body). Either keep `agent_publisher_authorizations` for that case (failure to unify) or invent a parallel storage anyway.
- Catalog disputes have nowhere to land — `disputed` is a column on the table.
- `bulkGetFirstAuthForAgents` becomes `WHERE auth->>'url' = ANY($1)` over the LATERAL — no index.

This option is genuinely simple to ship but doesn't survive the first scale spike. The Setupad escalation path (catalog-aware listing) becomes slow exactly when the catalog is useful.

### Option C — Authorization as `catalog_facts` rows

`catalog_facts` already exists for evidence-bearing assertions about identifiers and properties. Authorization could just be another fact:

```
fact_type='authorization'
subject_type='property_rid', subject_value=<rid>
predicate='agent_authorized_for'
object_value=<agent_url>
source=<evidence>
confidence=<confidence>
```

**Pros**
- Single fact-graph table for everything evidence-bearing.
- Trivial to add new authorization sources later (community attestations, addie analysis, etc.) — same shape.
- Append-only. Supersession via `superseded_by` covers expiration.

**Cons**
- `catalog_facts` is indexed for `(subject_type, subject_value)` — answers "all facts about property X" cheaply. **Does not** answer "all properties agent X is authorized for" — `object_value` has no index. Adding one would need to be partial (`WHERE predicate = 'agent_authorized_for'`) and is still a second per-fact-type indexing concession.
- Reader SQL is verbose: `WHERE fact_type='authorization' AND predicate='agent_authorized_for' AND ...` repeated everywhere, plus `subject_value::uuid` casts to JOIN to catalog_properties.
- Per-property and publisher-wide authorizations need different `subject_type` values (`property_rid` vs `publisher_domain`) — readers either query both or normalize.
- The original tracking issue (#3177) raised this option and rejected it as "noticeably more complex" for the dominant query patterns. The complexity is real and shows up in every reader, not just the writer.
- `disputed` becomes another fact (`predicate='dispute_raised'`) instead of a column — the dispute model from `catalog_identifiers` doesn't transfer cleanly.

## Comparison matrix

| Axis | A (table) | B (JSONB) | C (facts) |
|---|---|---|---|
| Reader latency on `getDomainsForAgent` | O(1) index | O(N publishers) | O(N facts) without index, O(1) with partial index per predicate |
| `bulkGetFirstAuthForAgents` (1K agents) | `agent_url = ANY` index hit | LATERAL on every publisher | Partial index hit if added |
| Indexes needed | 3 (agent / publisher / property) | None usable for equality | 1+ per predicate |
| Symmetry with `catalog_identifiers` | High (same shape) | Low | Low (different table) |
| Override-layer key alignment | Direct (agent_url + property_id) | Same JOIN, slower | Indirect (object_value cast) |
| Writer complexity | One projection step | Zero (writer just caches manifest) | One projection step (per-fact insert) |
| Backfill from legacy | One INSERT … SELECT | None | One INSERT … SELECT |
| Buying-agent claims (`source='agent_claim'`) | Same row, different `evidence` | Doesn't fit | Same fact, different `source` |
| Disputes | Column on the row | No place | Another fact type |
| Future flexibility | Good (add columns) | Limited | Best (new predicates) |
| Complexity in readers (lines of SQL) | Lowest | Highest LATERAL | High |
| Agent-side snapshot wire size (long-run) | ~150 MB gzipped | ~10 GB gzipped (full manifests) | ~150 MB gzipped |
| Delta sync key | `updated_at` | `publishers.last_validated` (over-pulls) | `superseded_by` chain |

## Agent-side sync

Verification is the load-bearing query for buy-side and sell-side agents: "is agent X authorized to sell property Y?" answered inline during bid filtering, settlement, audit. Per-call API checks are too slow for inline use (network RTT dominates). The realistic deployment is **agent maintains a local copy** and refreshes it on a schedule.

Option A is the only option that supports this cleanly.

### Sizing

Per-row footprint of `catalog_agent_authorizations`:

| Field | Avg | p99 |
|---|---|---|
| id (uuid) | 16 B | 16 B |
| agent_url (text) | ~80 B | ~256 B |
| property_rid (uuid, nullable) | 8 B (50% null) | 16 B |
| publisher_domain (text) | ~30 B | ~80 B |
| authorized_for (text) | ~150 B | ~500 B |
| property_ids (text[]) | ~50 B if present | ~200 B |
| evidence + confidence (text) | ~30 B | ~30 B |
| disputed + created_at + updated_at + deleted_at | ~30 B | ~30 B |
| **row total** | **~400 B** | **~1.1 KB** |

Cardinality:

| Stage | Publishers | Agents/publisher | Properties/agent | Rows | Uncompressed | gz |
|---|---|---|---|---|---|---|
| Today | ~10K | ~5 | ~2 | ~100K | ~40 MB | ~5 MB |
| Long-run | ~100K | ~10 | ~5 | ~5M | ~2 GB | **~150–300 MB** |

Compression ratio is high because `agent_url` and `publisher_domain` repeat heavily across rows.

### Sync endpoints (Option A)

```
GET /api/registry/authorizations/snapshot
  → gz JSONL of v_effective_agent_authorizations
  → Etag + X-Sync-Watermark: max(updated_at)
  → ~150 MB on the wire at long-run scale, single sequential read

GET /api/registry/authorizations/delta?since=<watermark>
  → rows where updated_at > $1, including soft-deletes (deleted_at not null)
  → KB to MB per call, indexed via idx_caa_sync
  → consumer applies in updated_at order, advances its watermark

GET /api/registry/authorizations?agent_url=<canonical>
  → narrow pull for an agent that only cares about its own rows
  → indexed via idx_caa_by_agent
  → small even at scale (one agent ≤ a few hundred rows)
```

Delta consumer pseudocode:

```
local_watermark = persisted("last_sync_watermark") or epoch
while true:
  page = GET /delta?since=local_watermark
  for row in page:
    if row.deleted_at: local.delete(row.id)
    else:              local.upsert(row)
  local_watermark = max(row.updated_at for row in page)
  persist("last_sync_watermark", local_watermark)
  sleep(poll_interval)
```

In-process lookup against the local copy is sub-microsecond. Daily delta is minutes of work for a desktop agent, KB on the wire.

### Why B and C don't get there

**Option B (JSONB-only)** can't ship a snapshot smaller than the manifest universe. Average `publishers.adagents_json` body is ~10 KB; 100K publishers × 10 KB = ~1 GB on the wire just to deliver authorization metadata, most of it irrelevant (signals, placements, agent metadata, contact info). No reasonable delta key — `publishers.last_validated` fires on any manifest change including unrelated edits, so consumers over-pull on every poll. Per-agent narrow pull is `LATERAL` over every manifest with no usable index.

**Option C (catalog_facts)** matches Option A on snapshot size and supports delta via `superseded_by`, but the consumer has to interpret supersession chains client-side rather than receiving a flat row stream with `deleted_at` tombstones. More state on the agent side and more places for sync logic to drift.

### Soft-delete is load-bearing

`deleted_at` is what makes delta sync work. Without it, a consumer cannot distinguish "no row in this delta" from "row was removed since my last sync." The delta endpoint emits the tombstone row (`deleted_at IS NOT NULL`) and the consumer applies the deletion locally. This is the same pattern `/registry/feed` uses for property-identity changes and is the reason both `updated_at` and `deleted_at` are in the schema from day one rather than added in a follow-up.

Hard-deleting auth rows (rather than soft-deleting) is a sync data-loss bug that surfaces only in the worst case — agents quietly drifting from the canonical set, with no signal until verification fails downstream.

## Recommendation

**Option A.** The dominant query patterns want index hits on `agent_url`, `publisher_domain`, and `property_rid`. The override layer was already designed to key on the same fields. Catalog disputes and the evidence/confidence vocabulary already exist on `catalog_identifiers` — Option A reuses both verbatim. And — the load-bearing point for agent deployment — Option A is the only option that supports a sub-200 MB snapshot + KB-scale delta sync (see "Agent-side sync" above), which is what makes inline verification realistic.

Option B is reachable later as a degenerate case of Option A — drop the table, add JSONB-driven readers — if the table proves to be redundant overhead. Going B → A means a schema migration plus a backfill plus a writer change. Going A → B is "remove the table." The asymmetric reversal cost favors picking A first. (B also can't ship a snapshot smaller than the full manifest universe, ~10× larger than A's, which closes the door on agent-side caching.)

Option C is technically the most flexible substrate, but flexibility is paid for in every reader and on every sync consumer. The dominant patterns don't need it; the optionality value is largely speculative ("future evidence sources we haven't built yet"). If we do grow new evidence sources, they can land in Option A's table with a new `evidence` value — adding a row, not a new abstraction.

## Open questions (defer to PR 4b implementation)

1. **`property_rid IS NULL` semantics.** A row with `property_rid IS NULL` and `publisher_domain = 'foo.example'` means "agent X is authorized publisher-wide for foo.example." The legacy tables had this concept implicit in `agent_publisher_authorizations`. Confirm consumers are OK with NULL-as-wildcard and not, e.g., a sentinel `property_rid`.

2. **`property_ids[]` array column.** Legacy `agent_publisher_authorizations.property_ids` carried an array of slug references when authorization was limited to specific properties. With `property_rid` as the row scope, this array is largely redundant — keep it for round-trip fidelity to the manifest, or expand into one row per property at write time? Recommend the latter for query simplicity, but it changes write-side semantics slightly.

3. **Buying-agent claim TTL.** Legacy `agent_publisher_authorizations` had `expires_at` for `source='agent_claim'` rows. Catalog adds the same column on `catalog_agent_authorizations`, with the catalog cleanup job sweeping expired rows.

4. **Effective-set view name.** `v_effective_agent_authorizations` — apply override layer (`add` / `suppress`) to base `catalog_agent_authorizations`. Bikeshed name; the shape is settled.

5. **Wildcard agent (`url = '*'`).** Already supported in the legacy reader and pinned by the PR 3 baseline (`bulkGetFirstAuthForAgents` test). Carry through unchanged — `agent_url = '*'` is just another row.

6. **Sync endpoint auth model.** The snapshot/delta endpoints expose every publisher's authorized-agent set. Public read makes sense (the manifest body is already public via `.well-known/adagents.json`), but throttling, ETag/If-None-Match, and snapshot pagination need design. Likely follow-up after PR 4b lands the table.

7. **Watermark vs sequence-number for delta.** `updated_at` is wall-clock and can have ties at sub-microsecond resolution under concurrent writes. For correctness under heavy ingest, a monotonic sequence number (e.g. `bigserial seq_no`) is safer than `updated_at` as the delta key. Keep `updated_at` for the schema as documented above; add `seq_no` if real concurrent-write rates warrant it.

## Sequencing

```
PR 4b-prereq: schema (catalog_agent_authorizations) + backfill migration
PR 4b:       writer extension (project authorized_agents → catalog_agent_authorizations)
              + reader cutover (UNION pattern matching 4a, legacy preferred during dual-write)
PR 5:        drop discovered_properties, agent_property_authorizations,
              agent_publisher_authorizations, discovered_publishers
```

The schema PR is the gating artifact this doc unblocks. Once it's reviewed and merged, PR 4b can use the same UNION-with-legacy-preference pattern as PR 4a, the PR 3 auth baseline tests stay valid, and PR 5 drops the legacy tables once one release of stable dual-write/single-read is in production.
