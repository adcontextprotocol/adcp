# Registry Authorization Model

**Status**: Proposal — gating artifact for PR 4b of #3177

**Decision needed**: Where do agent → publisher / agent → property authorizations live in the catalog?

## TL;DR

Recommend **Option A: first-class `catalog_agent_authorizations` table**, mirroring `catalog_identifiers`'s evidence + dispute pattern. It's the only option that supports the dominant query patterns at indexed-lookup speed, integrates cleanly with the override layer that already shipped (`adagents_authorization_overrides`), and unifies the two parallel legacy tables (`agent_property_authorizations` + `agent_publisher_authorizations`) into one.

The other two options either sacrifice query performance (Option B: read JSONB on every call) or pay structural cost for flexibility we don't need (Option C: store auth as `catalog_facts`).

**Scope of v1.** This doc addresses property-side authorization variants (`property_ids`, `inline_properties`, and the lexical-anchor case for `publisher_properties`). Tag-scoped authorization (`property_tags`), cross-publisher third-party sales claims (full `publisher_properties` semantics), and signal-side authorization (`signal_ids` / `signal_tags`) are explicit non-goals — see "Authorization variants" below.

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

## Authorization variants in adagents.json

The manifest schema defines `authorized_agents[]` as a `oneOf` over six discriminated variants. Each maps to a different projection rule:

| `authorization_type` | What it asserts | v1 projection |
|---|---|---|
| `property_ids` | Agent authorized for specific properties named by slug in the same manifest | One row per resolved `property_rid`. |
| `inline_properties` | Agent authorized for properties defined inline in the auth entry (not in top-level `properties[]`) | One row per inline property; identifiers go through the same publisher-anchor guards as the top-level properties. |
| `publisher_properties` | Agent authorized across multiple publishers' inventories (third-party sales agent pattern) | **Constrained**: only the lexically-anchored case lands at `evidence='adagents_json'`. Cross-publisher claims (manifest at `agent.example` claiming `cnn.com` properties) are refused at the writer — same anchor rule as `projectPropertyToCatalog`. The v3 fix for the cross-publisher case requires either signed cross-attestation or a corroborating publisher-side claim; deferred. |
| `property_tags` | Agent authorized for "all properties tagged X" | **Deferred**. Resolving tags at write time means writes block on the property catalog being current; properties tagged after the fact never become authorized. Resolving at read time means every reader scans tag bindings. Either way, behavior is qualitatively different from the per-property cases. Out of scope for v1; tag-scoped readers continue to read from the legacy table or `publishers.adagents_json` JSONB until a separate model lands. |
| `signal_ids` / `signal_tags` | Agent authorized to use specific data-provider signals | **Out of scope**. Signal authorization has different semantics (data-provider hosted, different override layer keying) and gets its own table or a `host_type` discriminant on this one. Tracked but not part of the property registry unification. |

The writer projects only the property-side variants. For unsupported variants, the auth row is *not* written to `catalog_agent_authorizations`; the legacy table continues to receive these rows during the dual-write window, and readers that need tag-scoped or signal-scoped auth read from the manifest body in `publishers.adagents_json` JSONB or from the legacy table directly.

This is a real reduction in scope from "unify all authorization" to "unify property authorization." It's the only honest framing — the override layer (migration 432) was scoped to property-side authorization too, and the alternative (model all six variants in the schema PR) extends the gating decision indefinitely.

## Options

### Option A — First-class `catalog_agent_authorizations` table

```sql
CREATE TABLE catalog_agent_authorizations (
  id                   UUID PRIMARY KEY,
  seq_no               BIGSERIAL NOT NULL UNIQUE,         -- monotonic delta-sync cursor
  agent_url            TEXT NOT NULL,                     -- raw manifest value, round-trip
  agent_url_canonical  TEXT NOT NULL,                     -- canonicalized (matches override layer column)
  property_rid         UUID REFERENCES catalog_properties,-- NULL = publisher-wide
  property_id_slug     TEXT,                              -- manifest slug at write time (for override JOIN)
  publisher_domain     TEXT,                              -- ONLY when property_rid IS NULL; derived via JOIN otherwise
  authorized_for       TEXT,                              -- free-text scope from manifest, length-capped 500
  evidence             TEXT NOT NULL                      -- trust signal; sole source of truth (see column notes)
    CHECK (evidence IN ('adagents_json', 'agent_claim', 'community')),
  disputed             BOOLEAN NOT NULL DEFAULT FALSE,
  created_by           TEXT,                              -- 'system', member_id, or asserting agent_url for claims
  expires_at           TIMESTAMPTZ,                       -- only meaningful for evidence='agent_claim'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),-- human-readable change time; NOT a sync cursor
  deleted_at           TIMESTAMPTZ,                       -- soft-delete tombstone

  -- Foundational URL canonicalization invariant — full canonicalization is
  -- applied by the writer; schema enforces lowercase + no trailing slash so
  -- two writers cannot diverge on the simplest cases. Wildcard '*' is the
  -- one accepted exception.
  CONSTRAINT chk_caa_agent_url_canonical
    CHECK (agent_url_canonical = '*'
        OR (agent_url_canonical = lower(agent_url_canonical)
        AND agent_url_canonical NOT LIKE '%/')),

  -- publisher_domain is only stored on publisher-wide rows; per-property
  -- rows derive it via JOIN on property_rid → catalog_properties.created_by
  -- to prevent drift if a property is later re-keyed.
  CONSTRAINT chk_caa_publisher_domain_scope
    CHECK ((property_rid IS NULL AND publisher_domain IS NOT NULL)
        OR (property_rid IS NOT NULL AND publisher_domain IS NULL))
);

-- Active-set partial unique: one row per (agent, scope, evidence) when live.
-- Tombstones accumulate without conflict.
CREATE UNIQUE INDEX idx_caa_unique_active
  ON catalog_agent_authorizations
  (agent_url_canonical,
   COALESCE(property_rid::text, ''),
   COALESCE(publisher_domain, ''),
   evidence)
  WHERE deleted_at IS NULL;

-- Reader indexes — partial on deleted_at IS NULL, mirroring the override
-- layer's pattern, so tombstone bloat doesn't slow live-row queries.
CREATE INDEX idx_caa_by_agent
  ON catalog_agent_authorizations (agent_url_canonical)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_caa_by_publisher
  ON catalog_agent_authorizations (publisher_domain)
  WHERE publisher_domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_caa_by_property
  ON catalog_agent_authorizations (property_rid)
  WHERE property_rid IS NOT NULL AND deleted_at IS NULL;

-- Sync index — NOT partial; tombstones must be visible to delta consumers
-- so they can apply deletions locally.
CREATE INDEX idx_caa_seq ON catalog_agent_authorizations (seq_no);

-- Override JOIN index — matches override layer's (agent_url_canonical,
-- property_id) keying.
CREATE INDEX idx_caa_override_join
  ON catalog_agent_authorizations (agent_url_canonical, property_id_slug)
  WHERE deleted_at IS NULL;
```

A few load-bearing column choices, since reviewers flagged each one:

- **`agent_url` + `agent_url_canonical`** mirrors the override layer (migration 432). The override view JOINs on `agent_url_canonical`; if this table only stored a single column, two writers could disagree on canonicalization rules and the JOIN would fire false-positive duplicates.

- **`property_id_slug`** is the publisher's manifest-declared slug, distinct from `property_rid`. The override layer keys on the slug (because that's what was published when the override was raised); the catalog identity (`property_rid`) didn't exist yet. Carrying both columns is the simplest way to make the override JOIN compose without a translation table.

- **`seq_no` is the delta cursor**, not `updated_at`. Postgres `now()` resolution is microsecond and a single transaction (e.g. `cacheAdagentsManifest` writing 10K rows) gets identical `updated_at` on every row. A consumer paginating within a timestamp would silently miss the rest of the batch. `BIGSERIAL` gives a monotonic sequence that's safe under any concurrent-write rate. `updated_at` stays as a human-readable change time — useful in admin tooling, never the cursor.

- **`publisher_domain` is partial** (only when `property_rid IS NULL`). Per-property rows derive the publisher via JOIN to `catalog_properties.created_by`. Storing it on per-property rows is denormalization that risks drift if a property's owning publisher changes — and the dominant per-publisher reader (`getAgentsForDomain`) already needs to UNION publisher-wide rows with per-property rows JOIN'd through `catalog_properties`, so the partial column doesn't add reader complexity.

- **`property_ids[]` array is gone.** Legacy `agent_publisher_authorizations.property_ids` carried slug references for the "publisher-wide auth limited to these properties" case. With `property_rid` as the row scope, the writer expands one auth row per resolved property at write time. One-row-per-(agent, property) is what the snapshot consumers want; the array was a third mode that defeated the unification claim.

- **`created_by`** distinguishes which agent (or system) wrote each row. For `evidence='agent_claim'` rows, this is the asserting agent's URL — required for revocation paths ("agent X is no longer trusted; remove all rows where the claim came from agent X").

- **`evidence` carries the trust signal; there is no separate `confidence` column.** `catalog_identifiers` uses a four-value `confidence` scale (`authoritative`/`strong`/`medium`/`weak`) calibrated for identifier corroboration across multiple data pipelines. Authorization has only three real trust states, and they map 1:1 to the `evidence` source: `adagents_json` is authoritative-by-definition (publisher's own .well-known file under HTTPS), `agent_claim` is the asserting agent's word for it, `community` is moderator-curated. Storing both columns invited writers to make up gradations that don't carry meaning at the reader. Drop `confidence`; if a future evidence source needs a separate trust gradation, add it as a new `evidence` value. The dispute layer (`disputed` boolean) handles the "this row is contested" case orthogonally.

- **`expires_at` is for `agent_claim` rows.** Legacy `agent_publisher_authorizations` had this column; preserve the semantics. Claims sweep on expiry via the catalog cleanup job. `evidence='adagents_json'` rows have no `expires_at` — they're refreshed on every successful crawl, so a stale row means the publisher's manifest stopped declaring the auth and the row should soft-delete (not expire on a TTL).

- **The override layer is scoped to `evidence='adagents_json'` rows only.** `adagents_authorization_overrides` was designed against the manifest body (publisher's declared authorizations); applying it to `agent_claim` rows doesn't make semantic sense (a moderator can't suppress someone's own self-assertion through an override layer keyed to a publisher's domain). Claims get revoked via `created_by`-based delete: when an asserting agent loses trust, the writer hard-deletes (or tombstones) every `evidence='agent_claim' AND created_by=<that_agent_url>` row in one statement. The schema PR enforces this scoping in the override view's JOIN condition.

- **Partial indexes excluding `deleted_at IS NOT NULL`** mirror the override layer's `WHERE superseded_at IS NULL` pattern. The sync index (`idx_caa_seq`) deliberately is *not* partial because delta consumers need to see tombstones.

- **`seq_no` must rotate on soft-delete.** A row that's tombstoned without a fresh `seq_no` is invisible to delta consumers (their cursor moved past the row's original `seq_no` when it was created), so revocations silently never propagate. This is a security-relevant failure: a revoked authorization continues to live in DSPs' local caches forever. Enforce via a trigger, not writer discipline:

```sql
CREATE FUNCTION caa_rotate_seq_no_on_tombstone() RETURNS trigger AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    NEW.seq_no := nextval('catalog_agent_authorizations_seq_no_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_caa_rotate_seq_no
  BEFORE UPDATE ON catalog_agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION caa_rotate_seq_no_on_tombstone();
```

The trigger ships in PR 4b-prereq alongside the table DDL.

- **Tombstone TTL = 90 days**, matching the change-feed retention window (`registry-change-feed.md`). After that, hard-delete via the catalog cleanup job. A consumer whose `cursor` is older than the feed retention gets HTTP 410 from the feed and must re-snapshot. Pinning the same number means there's exactly one offline-tolerance contract for the whole registry, not separate ones per entity type.

**Writer-side**: `cacheAdagentsManifest` extracts each `authorized_agents[]` entry from the manifest body. For each property-side variant covered above, the writer inserts one row per resolved `property_rid` (per-property scope) or one row with `property_rid IS NULL` (publisher-wide scope). Same security guards as the existing `projectPropertyToCatalog` (cross-publisher refusal, anchor rule) — the hijack risk on agent claims is symmetric to the property-identifier case.

The buying-agent claim path (`recordPublisherFromAgent`, today writing `agent_publisher_authorizations` with `source='agent_claim'`) lands here as `evidence='agent_claim'`, `created_by=<asserting_agent_url>`, `expires_at=<TTL from legacy>`. The two source types live side by side in one table; the snapshot endpoint **defaults to `evidence='adagents_json'` only** so a buy-side consumer that doesn't filter doesn't accidentally treat unverified claims as authorization (see "Agent-side sync" for the wire-format implication).

**Override-layer integration**: the effective authorization set is the union of (base rows minus rows matched by an active `suppress` override) and (active `add` overrides projected into the base shape). LEFT JOIN alone doesn't compose because `add` overrides need to surface phantom rows where there's no base row — that's the dominant `add` use case (the publisher's file is broken or missing, and a moderator is granting auth manually).

Concrete view:

```sql
CREATE VIEW v_effective_agent_authorizations AS
WITH base AS (
  SELECT
    caa.id, caa.agent_url, caa.agent_url_canonical,
    caa.property_rid, caa.property_id_slug,
    -- For per-property rows, derive publisher from the property's source pipeline.
    -- The strip generalizes across pipeline prefixes ('adagents_json:foo.example',
    -- 'community:foo.example', etc.) so adding a new pipeline doesn't break the
    -- view. The right long-term fix is a dedicated publisher_domain column on
    -- catalog_properties; tracked separately.
    COALESCE(caa.publisher_domain,
             regexp_replace(cp.created_by, '^[^:]+:', '')) AS publisher_domain,
    caa.authorized_for, caa.evidence,
    caa.disputed, caa.created_by, caa.expires_at,
    caa.created_at, caa.updated_at, caa.seq_no
  FROM catalog_agent_authorizations caa
  LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
  WHERE caa.deleted_at IS NULL
)
-- Base rows surface UNLESS a matching active 'suppress' override exists.
SELECT b.*, FALSE AS override_applied, NULL::text AS override_reason
FROM base b
WHERE NOT EXISTS (
  SELECT 1 FROM adagents_authorization_overrides ov
  WHERE ov.superseded_at IS NULL
    AND ov.override_type = 'suppress'
    AND ov.host_domain = b.publisher_domain
    AND ov.agent_url_canonical = b.agent_url_canonical
    AND COALESCE(ov.property_id, '') = COALESCE(b.property_id_slug, '')
)
UNION ALL
-- Active 'add' overrides surface as effective rows (regardless of base).
SELECT
  ov.id, ov.agent_url, ov.agent_url_canonical,
  NULL::uuid AS property_rid,           -- 'add' overrides don't carry a rid
  ov.property_id AS property_id_slug,
  ov.host_domain AS publisher_domain,
  ov.authorized_for, 'override' AS evidence,
  FALSE AS disputed,
  ov.approved_by_user_id AS created_by,
  NULL::timestamptz AS expires_at,
  ov.created_at, ov.created_at AS updated_at,
  NULL::bigint AS seq_no,                -- override sequencing is independent
  TRUE AS override_applied,
  ov.override_reason
FROM adagents_authorization_overrides ov
WHERE ov.superseded_at IS NULL
  AND ov.override_type = 'add';
```

Walk-through of the three cases the reviewers asked about:

1. **`bad_actor 'suppress'` against an authoritative auth row.** Base row exists; the suppress override matches on `(host_domain, agent_url_canonical, property_id)`. The `NOT EXISTS` clause filters the base row out. No `add` override surfaces. Net: row hidden. ✓
2. **`correction 'add'` after publisher's file went missing.** No base row exists (or there is one but with stale data). The override is in the `UNION ALL` second arm and surfaces as an effective row, tagged `override_applied=TRUE` so consumers can show provenance. ✓
3. **`'add' WHERE property_id IS NULL`** (publisher-wide moderator-granted auth). Base row may or may not exist. The `add` override surfaces with `property_rid=NULL` and `property_id_slug=NULL`; consumers see a publisher-wide authorization. ✓

The view also exposes `override_applied` (boolean) and `override_reason` (override_reason from the override layer, or NULL). Snapshot consumers querying `?include=raw` get base rows directly without applying the view; consumers querying the default endpoint get the effective set with provenance.

**Property metadata for `add`-override rows**: the override layer keys on `property_id` (manifest slug), not on `property_rid`. So `add`-override rows in the view emit `property_rid IS NULL` even when the override's slug resolves to a real `catalog_properties` row. Consumers that need property metadata (name, type, identifiers) for an `add`-override row should JOIN through `(publisher_domain, property_id_slug)` against `catalog_properties.created_by` and the catalog_identifiers index — not via `property_rid`. The catalog API will surface this JOIN as a helper rather than asking every consumer to write it.

**UNIQUE-key intent on `agent_claim` rows**: the active-set unique index keys on `(agent_url_canonical, property_rid_or_publisher_domain, evidence)` — *not* on `created_by`. Design intent is "any one claim per (agent, scope) regardless of which agent is asserting it." If two distinct buying agents both claim authorization for the same (agent, publisher), the second writer wins (replaces the first). This matches the legacy behavior of `agent_publisher_authorizations.UNIQUE(agent_url, publisher_domain, source)`. If we ever need per-claimant rows (e.g. "agent A claims this; agent B disputes it"), add `created_by` to the unique key in a follow-up — but doing so today would require resolving "which claimant wins for snapshot purposes," which doesn't have a clean answer.

**Backfill**: one-time migration copies legacy rows into the new table. Both `agent_property_authorizations` (per-property) and `agent_publisher_authorizations` (per-publisher) flatten into the same shape. Legacy `source` field maps to `evidence`. Note that `agent_publisher_authorizations.property_ids` is an array — when non-NULL, the backfill `CROSS JOIN LATERAL unnest(property_ids)` to produce one row per resolved property, plus a separate insert for NULL `property_ids` (the publisher-wide case). Not a one-line statement; the schema PR includes both branches.

**Pros**
- Indexed lookups on every dominant query pattern. `getDomainsForAgent` is `WHERE agent_url = $1` — index hit.
- `bulkGetFirstAuthForAgents` is `WHERE agent_url = ANY($1)` with the existing index pattern.
- Symmetric with `catalog_identifiers` — readers reuse the same `evidence` vocabulary, dispute layer attaches naturally.
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
| Delta sync key | `seq_no` (BIGSERIAL) reuses existing change feed | `publishers.last_validated` (over-pulls) | `superseded_by` chain (consumer interprets) |
| Override JOIN composes | Direct (agent_url_canonical + property_id_slug) | Same JOIN, scans full JSONB | Cast through `subject_value::uuid` |
| Variant coverage (v1) | property_ids + inline (anchor case) | All variants but slow | All variants but reader-complex |

## Agent-side sync

Verification queries split by deployment shape:

- **Most adopters use the narrow per-agent endpoint.** A DSP, sales house, or agency only cares about the rows where it appears as `agent_url` — typically a few hundred rows. The endpoint is `GET /api/registry/authorizations?agent_url=<canonical>`, indexed via `idx_caa_by_agent`, sub-millisecond per call. This is the default deployment path — the spec's earlier framing as "agent maintains a local copy" was wrong about the common case.
- **High-QPS inline verifiers maintain a local copy.** A DSP doing inline bid filtering can't afford network round-trips. For them, snapshot + delta is the pattern.
- **Per-call full-set lookups** ("who can sell domain Y?") run against the indexed reader — no caching needed for low-QPS callers (settlement reconciliation, audit tooling, ops dashboards).

Option A is the only option that supports all three shapes cleanly.

### Sizing

Per-row footprint of `catalog_agent_authorizations`:

| Field | Avg | p99 |
|---|---|---|
| id (uuid) | 16 B | 16 B |
| agent_url (text) | ~80 B | ~256 B |
| property_rid (uuid, nullable) | 8 B (50% null) | 16 B |
| publisher_domain (text) | ~30 B | ~80 B |
| authorized_for (text) | ~150 B | ~500 B |
| evidence (text) | ~15 B | ~15 B |
| property_id_slug (text) | ~20 B if present | ~80 B |
| seq_no + disputed + expires_at + 3× timestamp | ~50 B | ~50 B |
| **row total** | **~360 B** | **~1.0 KB** |

Cardinality:

| Stage | Publishers | Agents/publisher | Properties/agent | Rows | Uncompressed | gz |
|---|---|---|---|---|---|---|
| Today | ~10K | ~5 | ~2 | ~100K | ~40 MB | ~5 MB |
| Long-run | ~100K | ~10 | ~5 | ~5M | ~2 GB | **~150–300 MB** |

Compression ratio is high because `agent_url` and `publisher_domain` repeat heavily across rows.

### Sync endpoints (Option A)

The narrow-pull endpoint is the default. Snapshot + delta is the high-QPS path — and it reuses the existing `/api/registry/feed` infrastructure (`specs/registry-change-feed.md`) for delta delivery rather than inventing a parallel mechanism.

```
GET /api/registry/authorizations?agent_url=<canonical>&include=<raw|effective>
  → DEFAULT endpoint for most adopters
  → indexed via idx_caa_by_agent + idx_caa_by_property
  → small per call (one agent ≤ ~few hundred rows)
  → ?include=effective (default) applies the override view; ?include=raw returns base rows
  → ?evidence=adagents_json,agent_claim filters by source (defaults to adagents_json only)

GET /api/registry/authorizations/snapshot?evidence=<csv>&include=<raw|effective>
  → bootstrap for inline verifiers
  → gz JSONL of v_effective_agent_authorizations
  → ETag + X-Sync-Cursor: <event_id> at snapshot time (UUIDv7, matching feed)
  → ~150 MB on the wire at long-run scale (effective set, evidence='adagents_json')
  → DEFAULT excludes evidence='agent_claim' to prevent buy-side trust footgun

GET /api/registry/feed?entity_type=authorization&cursor=<event_id>
  → REUSES the existing UUIDv7-cursor change feed (registry-change-feed.md)
  → emits authorization.granted / authorization.revoked / authorization.modified events
  → consumer applies events in event_id order, advances cursor
```

The change feed is the canonical delta mechanism for the registry — the property-side cutover already uses it for `property.created` / `property.removed`. Authorization events are a new `entity_type` filter on the same feed; same UUIDv7 `cursor` parameter, same retention window, same recovery semantics. The snapshot endpoint exists only to bootstrap a consumer that's never synced before; once bootstrapped, the change feed is the live source. **`seq_no` on the table is internal — it orders rows for the change-feed emitter and for view-layer pagination, but it never crosses the wire.** Consumers see only `event_id`.

`agent_claim` rows are excluded from the snapshot by default. Consumers that want unverified self-asserted authorizations (e.g. a registry-internal admin tool, or a DSP that has its own trust-by-vendor policy) opt in with `?evidence=adagents_json,agent_claim`. Mixing them by default would let a buy-side platform that doesn't filter treat self-claims as authoritative — exactly the failure mode the override layer was designed to prevent.

Delta consumer pseudocode (using the change feed):

```
local_cursor = persisted("last_feed_cursor") or 'snapshot'
if local_cursor == 'snapshot':
  snapshot = GET /api/registry/authorizations/snapshot
  for row in snapshot.rows:
    local.upsert(row)
  local_cursor = snapshot.headers['X-Sync-Cursor']  -- a UUIDv7 event_id
  persist("last_feed_cursor", local_cursor)
while true:
  events = GET /api/registry/feed?entity_type=authorization&cursor=local_cursor
  for ev in events:
    if ev.type == 'authorization.revoked':
      local.delete(ev.entity_id)
    else:
      local.upsert(ev.payload)
  local_cursor = events.next_cursor
  persist("last_feed_cursor", local_cursor)
  sleep(poll_interval)
  -- if server returns 410 Gone, cursor is older than feed retention;
  -- consumer must re-snapshot
```

In-process lookup against the local copy is sub-microsecond. Daily feed pull is minutes of work for a desktop agent, KB on the wire.

### Trust model

The snapshot and feed inherit the registry's overall trust model. The change-feed spec (R-1, "Feed-event content signing") tracks the cryptographic attestation work for AdCP 4.0; until that lands, the snapshot is trust-the-registry-operator with a verify-by-refetch escape hatch — every effective row carries `publisher_domain`, and a paranoid consumer can re-fetch `https://<publisher_domain>/.well-known/adagents.json` directly to confirm. The `?include=raw` endpoint exists in part to support this audit path (it returns the base rows so consumers can compare to the manifest body).

This isn't a new design decision — it's the same trust posture as the property-side reader cutover. The auth-model spec doesn't try to solve attestation; that's R-1's job.

### Why B and C don't get there

**Option B (JSONB-only)** can't ship a snapshot smaller than the manifest universe. Average `publishers.adagents_json` body is ~10 KB; 100K publishers × 10 KB = ~1 GB on the wire just to deliver authorization metadata, most of it irrelevant (signals, placements, agent metadata, contact info). No reasonable delta key — `publishers.last_validated` fires on any manifest change including unrelated edits, so consumers over-pull on every poll. Per-agent narrow pull is `LATERAL` over every manifest with no usable index.

**Option C (catalog_facts)** matches Option A on snapshot size and supports delta via `superseded_by`, but the consumer has to interpret supersession chains client-side rather than receiving a flat row stream with `deleted_at` tombstones. More state on the agent side and more places for sync logic to drift.

## Why publishers participate

The doc above is buy-side-coded — DSPs, sales houses, agencies pulling and verifying. A publisher reading this should be able to answer "why am I in this catalog vs. just hosting `.well-known/adagents.json` and being done?" Three concrete reasons:

1. **Discoverability.** Buyer agents subscribed to `/api/registry/change-feed?entity_type=authorization` see a publisher's authorized agents the moment the crawler picks up the manifest — no per-buyer crawl needed. For new publishers especially, this collapses time-to-discovery from "whenever each buyer's crawler gets to you" to "next change-feed poll."

2. **Bad-actor protection via the override layer.** A publisher whose `.well-known/adagents.json` is being misrepresented (a buying agent claiming authorization that wasn't granted) can file a `bad_actor 'suppress'` override through the registry's moderation flow. The override propagates through the change feed to every consumer of `v_effective_agent_authorizations`. Without the catalog, the publisher's only recourse is changing the file and waiting for buyers to re-crawl — which can take days or weeks.

3. **Cross-validation against agent claims.** The `evidence='agent_claim'` rows expose which buying agents are claiming to sell a publisher's inventory without that publisher's `adagents.json` declaring them. Publishers can audit this set and either issue overrides (if claims are wrong) or update their manifest (if the claims are valid and the manifest is missing entries).

The catalog isn't a replacement for `.well-known/adagents.json` — the manifest is still the source of truth, and the catalog reads from it. The catalog adds a delivery and moderation layer on top.

## Recommendation

**Option A.** The dominant query patterns want index hits on `agent_url_canonical`, `publisher_domain`, and `property_rid`. The override layer was already designed to key on the same fields, and the proposed `agent_url_canonical` + `property_id_slug` columns make the JOIN compose cleanly. Catalog disputes and the evidence vocabulary already exist on `catalog_identifiers` — Option A reuses them. And — the load-bearing point for agent deployment — Option A is the only option that supports a sub-200 MB snapshot + change-feed delta (see "Agent-side sync" above), which is what makes inline verification realistic.

Option B is reachable later as a degenerate case of Option A — drop the table, add JSONB-driven readers — if the table proves to be redundant overhead. Going B → A means a schema migration plus a backfill plus a writer change. Going A → B is "remove the table." The asymmetric reversal cost favors picking A first. (B also can't ship a snapshot smaller than the full manifest universe, ~10× larger than A's, which closes the door on agent-side caching.)

Option C is technically the most flexible substrate, but flexibility is paid for in every reader and on every sync consumer. The dominant patterns don't need it; the optionality value is largely speculative ("future evidence sources we haven't built yet"). If we do grow new evidence sources, they can land in Option A's table with a new `evidence` value — adding a row, not a new abstraction.

## Open questions (defer to PR 4b-prereq schema review)

Reviewer feedback has resolved most questions from the original draft (`confidence` dropped; `agent_claim` lives in the same table with `expires_at` and override-layer scoping; tombstone TTL pinned to change-feed retention; `seq_no` rotation enforced by trigger). The remaining open items:

1. **Override sequencing wire format in the change feed.** Design intent settled: when an override is inserted or superseded, the change-feed emitter generates `authorization.modified` events with synthetic UUIDv7 `event_id`s — one per base row whose effective state changed (suppressed/unsuppressed) plus one for the override itself (granted/revoked). Consumers don't see override-vs-base distinction; they see effective-state transitions. **What's open**: the event payload shape (which fields ship in the body, whether `override_reason` is exposed, whether `add`-overrides include the override's `property_id_slug` or just the resolved publisher_domain). Settled in PR 4b-feed.

2. **Wildcard agent (`url = '*'`).** The CHECK explicitly allows `*` as a sentinel that bypasses URL canonicalization. Pinned by the PR 3 baseline. Open: the semantics ("any agent") are publisher-wide and global, but readers must know to expand wildcard rows during effective-set computation. Document the expansion rule in the schema migration's comments.

3. **`property_tags` and `inline_properties` projection.** Both are deferred from v1 (see "Authorization variants"). The legacy table continues to receive these rows; readers that need them go to the manifest body. When tag-scoped authorization becomes a real product requirement (signal-side first, probably), the projection model becomes its own design discussion — most likely a separate `catalog_tag_authorizations` table referencing the catalog's tag binding state.

4. **Cross-publisher `publisher_properties` (third-party sales).** Refused at write time by the anchor rule. Re-opening this requires a corroboration mechanism — the spec for that lives downstream and doesn't gate this work. Track separately.

## Sequencing

```
PR 4b-prereq: schema (catalog_agent_authorizations + v_effective_agent_authorizations
              + soft-delete trigger) + backfill from agent_property_authorizations
              and agent_publisher_authorizations
PR 4b-feed:   change-feed entity_type='authorization' wire format (small spec PR
              against registry-change-feed.md, plus the emitter) — can run parallel
              with 4b-prereq once the schema is settled
PR 4b:        writer extension (project authorized_agents → catalog_agent_authorizations,
              with anchor + cross-publisher guards mirroring projectPropertyToCatalog)
              + reader cutover (UNION matching 4a, legacy preferred during dual-write)
              + snapshot/narrow-pull endpoints
PR 5:         drop discovered_properties, agent_property_authorizations,
              agent_publisher_authorizations, discovered_publishers
```

The schema PR (4b-prereq) is the gating artifact this doc unblocks. Once it's reviewed and merged, the writer + reader cutover (4b) can use the same UNION-with-legacy-preference pattern as PR 4a, the PR 3 auth baseline tests stay valid, the change feed extends naturally to authorization events, and PR 5 drops the legacy tables once one release of stable dual-write/single-read is in production.
