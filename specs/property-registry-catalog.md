# Property Catalog

**Status**: Draft

## Problem

The property registry only contains publisher-opted-in properties. Buyer agents need the full universe of addressable properties to build lists against, and those properties need stable IDs (`property_rid`) for TMP context-match requests. Today's registry has ~1K properties from `adagents.json` crawling. The addressable internet has millions.

## Core Insight

The catalog is a **fact graph**. It accumulates facts from multiple data sources — app stores, `adagents.json` crawls, `ads.txt`, member contributions, web crawls — and derives a property graph from those facts. The graph is the current best interpretation of all accumulated evidence.

A fact is an assertion with a source, a confidence level, and a timestamp:
- "nytimes.com is a website" (source: adagents.json, confidence: authoritative)
- "com.nytimes.nytimes is an iOS bundle for the same publisher as nytimes.com" (source: app_store, confidence: strong)
- "flashtalking.net is ad infrastructure" (source: ads.txt analysis, confidence: strong)
- "obscure-blog.com exists and takes advertising" (source: agency_allowlist via scope3, confidence: medium)

The graph materializes these facts into: properties (with stable `property_rid`s), their identifiers, their classifications, and the links between them.

## Design Principles

1. **The catalog is a namespace** — identifiers in, `property_rid`s out. No scores, features, or coverage claims.
2. **Facts, not declarations** — the graph is built from accumulated evidence, not from any single source claiming authority. Even `adagents.json` is just the highest-confidence fact source — not the only one.
3. **Every fact has provenance** — where it came from, how confident we are, when we learned it. Facts can be superseded by stronger evidence.
4. **The rid is forever** — once assigned, a `property_rid` never changes or gets reused. When things go wrong (false merge, domain re-registration), we create new rids and alias the old ones.
5. **Classification protects the graph** — ad infrastructure, publisher masks, and network domains are identified and excluded before they can contaminate the property graph.
6. **The registry is the community adagents.json** — for properties without a self-hosted `adagents.json`, the registry IS the authoritative declaration, maintained by the community through contributed facts.

## Terminology

- **`property_id`** = publisher-controlled slug (`^[a-z0-9_]+$`) from `adagents.json`. Scoped to a publisher's file. Two publishers can both have `homepage`.
- **`property_rid`** = catalog-assigned UUID v7. Globally unique. Stable forever. The shared key for TMP matching.
- **fact** = an assertion about a property or identifier, with source, confidence, and timestamp.
- **evidence** = the basis for a fact (adagents_json, app_store, ads_txt, dns, member_assertion, addie_analysis).

## Fact Sources

The catalog's quality is determined by the facts it ingests. Each pipeline produces specific kinds of facts.

### Pipeline: adagents.json Crawler

**What it discovers**: Properties, their identifiers, ownership, authorization, governance agents.
**Confidence**: Authoritative — the publisher declared it.
**Frequency**: Daily crawl of known domains + weekly discovery crawl of contributed domains.

Facts produced:
- "nytimes.com declares property `nyt_web` with identifiers `(domain, nytimes.com)`"
- "nytimes.com declares property `nyt_ios` with identifiers `(ios_bundle, com.nytimes.nytimes)`, `(apple_app_store_id, 284862083)`"
- "nytimes.com authorizes `raptive.com` to sell `nyt_web`"
- "nytimes.com declares Scope3 as a governance agent for `carbon_score`"

This is the highest-confidence source. When it conflicts with other facts, it wins.

### Pipeline: App Store Crawler

**What it discovers**: App existence, bundle ↔ store ID links, developer identity, app metadata.
**Confidence**: Strong — Apple/Google/Roku are the authority on their own stores.
**Frequency**: Weekly full crawl of ad-supported apps.

Facts produced:
- "`ios_bundle: com.cnn.iphone` has `apple_app_store_id: 331786748`" (linking fact — these are the same app)
- "`ios_bundle: com.cnn.iphone` is published by developer `CNN Interactive Group`"
- "`android_package: com.cnn.mobile` is published by developer `CNN`"
- "`com.cnn.iphone` and `com.cnn.mobile` share developer identity `CNN`" (potential same-publisher signal, not same-property)

This is the primary source for **linking mobile/CTV identifiers**. When Scope3 resolves `ios_bundle: com.cnn.iphone` and the app store tells us the store ID is `331786748`, both identifiers get linked to the same `property_rid` automatically.

Important: same developer ≠ same property. CNN's iOS app and CNN's CTV app are different properties from the same developer. The app store tells us about developer identity (publisher-level), not property identity. Only `adagents.json` authoritatively declares which identifiers are the same property.

### Pipeline: ads.txt / sellers.json Crawler

**What it discovers**: Seller authorization, ad infrastructure identification, publisher-SSP relationships.
**Confidence**: Strong for authorization, medium for classification.
**Frequency**: Daily.

Facts produced:
- "nytimes.com authorizes seller_id `pub-nyt-12345` (DIRECT) via Raptive"
- "flashtalking.net appears as RESELLER across 50K+ ads.txt files" (classification signal: ad_infra)
- "microsoftadvertising.com appears as DIRECT seller for 200+ unrelated publishers" (classification signal: publisher_mask)

This is the primary source for **classification facts**. A domain that shows up as a RESELLER in thousands of ads.txt files is almost certainly ad infrastructure, not a property.

### Pipeline: Web Inventory Lists (Corroboration Only)

**What it discovers**: Domains that exist and have meaningful traffic.
**Confidence**: Low on its own. Value is in corroboration, not seeding.
**Frequency**: Monthly refresh.

Sources: Tranco (aggregates Chrome UX Report, Majestic, Cloudflare Radar, Umbrella), CrUX direct.

We explored the Tranco top 25K and found it's too noisy to ingest directly:
- ~5% matched known ad infra / CDN / DNS patterns
- 95% classified "unknown" — a mix of real properties, enterprise sites, platform infra, and junk
- Of reachable "unknown" domains, ~45% have ads.txt (ad-supported properties)
- Quality degrades sharply past rank 10K (gambling, parked domains, nonsense hostnames)

Tranco is a traffic ranking, not a property catalog. Without classification data (from Scope3 seed, ads.txt, or adagents.json), it's just a big list of domains.

**Right use of Tranco**:
- **Corroboration**: Domain already in catalog AND in Tranco top 25K → confidence boost (significant sustained traffic)
- **Absence signal**: Domain in catalog but NOT in Tranco → soft flag (could be new, could be garbage)
- **Classification tiebreaker**: For unclassified domains in the catalog, Tranco rank + ads.txt check together give a decent property/not-property signal

Facts produced:
- "nytimes.com has Tranco rank 312" (corroboration of existing property)
- "obscure-blog.com is not in Tranco top 1M" (absence signal — needs other evidence to justify catalog entry)

The Tranco list is loaded as an in-memory lookup service, not ingested into the fact table. The resolve endpoint can query it as a validation signal when classifying new domains.

### Pipeline: Member Resolve Calls

**What it discovers**: That a member believes an identifier exists and wants to address it.
**Confidence**: Varies by provenance type (see below).
**Frequency**: Continuous.

Facts produced:
- "Scope3 asserts `domain: obscure-blog.com` exists, provenance: agency_allowlist" (medium-high — an agency curated it)
- "Scope3 asserts `domain: sketchy-site.xyz` exists, provenance: impression_log" (medium-low — could be masked/fraud)
- "DoubleVerify asserts `ios_bundle: com.obscure.app` and `domain: obscure-blog.com` are the same property" (member_assertion — needs corroboration)

Resolve calls are the only **demand signal**. A property resolved by 5 members weekly from agency allowlists is clearly valuable. A property resolved once from an impression log 6 months ago might be noise.

| Provenance Type | Meaning | Confidence |
|----------------|---------|------------|
| `agency_allowlist` | Curated by an agency or advertiser | Medium-High |
| `ssp_inventory` | SSP onboarding their publisher portfolio | Medium-High |
| `deal_history` | From historical PMP/PG deal records | Medium-High |
| `impression_log` | Seen in bid stream or impression data | Medium — could include masked/fraud domains |
| `data_partner` | Third-party dataset | Medium |
| `member_assertion` | Explicit claim about identity/linking | Medium — needs corroboration |

### Pipeline: Addie Enrichment

**What it discovers**: Property metadata, content analysis, ownership signals, classification evidence.
**Confidence**: Medium — AI analysis, not authoritative declaration.
**Frequency**: Triggered by resolve activity (prioritizes high-demand properties).

Facts produced:
- "obscure-blog.com has ad placements and appears to be a content property" (classification: property)
- "obscure-blog.com whois registrant matches obscure-app.com" (weak linking signal)
- "some-domain.com serves only ad creatives, no editorial content" (classification signal: ad_infra)

Addie is the **intelligence layer** — it analyzes properties that other pipelines have identified but not fully classified. It prioritizes based on demand signals from the activity log.

## Identifier Classification

Not every identifier is a property. Classification happens before an identifier enters the property graph.

| Classification | Example | Catalog Behavior |
|---------------|---------|-----------------|
| `property` | cnn.com, com.nytimes.nytimes | Gets a rid, links identifiers, participates in TMP |
| `ad_infra` | flashtalking.net, doubleclick.net | No rid. Excluded from the graph. |
| `publisher_mask` | microsoftadvertising.com, safeframe.googlesyndication.com | No rid. Represents many properties behind it. |
| `network` | raptive.com, mediavine.com | Not a property itself. Parent entity that owns/manages properties. May have adagents.json declaring child properties. |
| `unclassified` | newly-seen-domain.com | Pending classification. Temporarily excluded from resolve results. Queued for analysis. |

### How Classification Is Determined

Classification is derived from accumulated facts:

- **ads.txt/sellers.json patterns**: Domain appears as RESELLER across 1000+ ads.txt files → `ad_infra`
- **adagents.json**: Domain declares properties → `property` or `network`
- **Impression patterns**: Thousands of unrelated creatives serve from same domain → `ad_infra`
- **Content analysis** (Addie): Domain serves editorial content with ad placements → `property`
- **TAG lists**: Known mask domains, certified sellers
- **Member assertions**: Explicit flags, requires corroboration

Classification can change as new facts arrive. The event log tracks transitions.

### TMP Implications of Classification

At TMP match time, the publisher sends the context-match request — they know who they are. CNN behind `microsoftadvertising.com` sends CNN's `property_rid`, not the mask's. Masks are not a TMP execution problem.

They're a **planning-time** problem: the resolve endpoint rejects mask and ad_infra identifiers, so buyers can't build property lists with them. And a **reconciliation** problem: impression logs show serving domains, not properties. Post-campaign validation needs to resolve through the mask to the actual property — which requires additional context the catalog alone can't provide.

Buyers can require `property`-only classification at the package level as a targeting constraint.

## Property Graph

The fact graph materializes into the property graph: properties with stable rids, linked to identifiers, with classification and ownership metadata.

### Resolution Level

A property is a single addressable surface where content lives and ads can appear. One property, one rid, many identifiers.

CNN might have:
- `property_rid: 019...aaa` — CNN website. Identifiers: `(domain, cnn.com)`
- `property_rid: 019...bbb` — CNN CTV app. Identifiers: `(roku_store_id, 12345)`, `(fire_tv_asin, B00ABC)`, `(apple_tv_bundle, com.cnn.ctv)`
- `property_rid: 019...ccc` — CNN mobile app. Identifiers: `(ios_bundle, com.cnn.iphone)`, `(apple_app_store_id, 331786748)`, `(android_package, com.cnn.mobile)`

The CTV app's three store IDs are linked by app store crawler facts. The mobile app's iOS and Android identifiers are linked by `adagents.json` (if declared) or by member assertion + developer identity corroboration.

When a buyer resolves a bare domain and no sub-properties are known, the catalog creates a single property entry. When the adagents.json crawler later discovers sub-properties, the original entry persists (existing references still resolve) and sub-properties get their own rids.

### Evidence-Based Linking

Identifiers get linked to properties based on facts. Each link records its evidence:

| Evidence | Example | Strength | Auto-Link? |
|----------|---------|----------|-----------|
| `adagents_json` | Publisher declared these identifiers in their property definition | Authoritative | Yes |
| `app_store` | Store metadata links bundle ID ↔ store ID for the same app | Strong | Yes — same app only |
| `ads_txt` | ads.txt links domain to seller_id | Strong for authorization, not for property identity | No |
| `dns` | CNAME/redirect chain connects domains | Medium | No — needs review |
| `member_assertion` | A member said these belong together | Medium | No — needs corroboration |
| `addie_analysis` | AI analysis of whois, content, SDK fingerprints | Medium | No — needs review |

**Auto-linking** happens only for high-confidence, unambiguous evidence: adagents.json declarations and same-app store ID lookups. Everything else requires corroboration or human review before identifiers get linked. This protects the graph from false merges.

### Graph Integrity Rules

1. **No cross-classification linking**: A `property` identifier cannot be linked to an `ad_infra` or `publisher_mask` entry.
2. **Same-developer ≠ same-property**: App store developer identity is a publisher-level signal, not a property-level one. CNN's iOS app and CTV app are different properties.
3. **Weaker evidence cannot override stronger**: If adagents.json says identifiers A and B are different properties, a member assertion that they're the same is rejected.
4. **Unresolved conflicts queue for review**: When facts conflict at the same confidence level, the identifiers are flagged for human review rather than auto-resolved.
5. **Aliases, not deletions**: When a merge is undone (false merge discovered), the incorrectly merged rid becomes an alias pointing to the correct canonical rid. Old references keep working.

### Graph Transitions

Every change to the graph is an event:

| Event | Trigger | Behavior |
|-------|---------|----------|
| `identifier_linked` | App store crawl, adagents.json, corroborated assertion | Add identifier to property's set |
| `identifier_unlinked` | Domain sold, app rebranded, false link discovered | Remove link. Identifier becomes unresolved or links to new property. |
| `properties_merged` | Two rids confirmed to be the same property | One rid canonical, other becomes alias. Aliases resolve transparently. |
| `properties_split` | False merge discovered | New rid created, some identifiers move. Old rid keeps remaining identifiers. |
| `source_upgraded` | adagents.json discovered for contributed property | Source changes, sub-properties may be created. |
| `classification_changed` | Evidence reclassifies domain (property → ad_infra) | Rid deactivated, excluded from resolve/browse/sync. |
| `ownership_changed` | Publisher sold, adagents.json authority shifts | Metadata updates. Rid stays stable. |

## Buyer Agent Workflow: Scope3 Example

An advertiser gives Scope3 a list of 500 domains for a low-carbon campaign. Here's the end-to-end flow.

### Step 1: Resolve Identifiers

One call. Identifiers in, `property_rid`s out. Missing properties auto-created (in `resolve` mode). Known ad_infra/masks excluded.

```
POST /api/registry/resolve
```

```json
{
  "identifiers": [
    { "type": "domain", "value": "nytimes.com" },
    { "type": "domain", "value": "bbc.co.uk" },
    { "type": "domain", "value": "obscure-blog.com" },
    { "type": "domain", "value": "flashtalking.net" }
  ],
  "provenance": {
    "type": "agency_allowlist",
    "context": "unilever_q3_display"
  }
}
```

Response:

```json
{
  "resolved": [
    {
      "identifier": { "type": "domain", "value": "nytimes.com" },
      "property_rid": "019539a0-b1c2-7d3e-8f4a-5b6c7d8e9f0a",
      "classification": "property",
      "status": "existing",
      "source": "authoritative"
    },
    {
      "identifier": { "type": "domain", "value": "bbc.co.uk" },
      "property_rid": "019539a0-d3e4-7f5a-ab6c-7d8e9f0a1b2c",
      "classification": "property",
      "status": "existing",
      "source": "contributed"
    },
    {
      "identifier": { "type": "domain", "value": "obscure-blog.com" },
      "property_rid": "019539a0-e4f5-7a6b-bc7d-8e9f0a1b2c3d",
      "classification": "property",
      "status": "created",
      "source": "contributed"
    },
    {
      "identifier": { "type": "domain", "value": "flashtalking.net" },
      "property_rid": null,
      "classification": "ad_infra",
      "status": "excluded"
    }
  ],
  "summary": {
    "total": 4,
    "resolved": 3,
    "created": 1,
    "excluded": 1
  },
  "server_timestamp": "2026-03-27T10:00:00Z"
}
```

`obscure-blog.com` gets created. `flashtalking.net` is excluded (the ads.txt crawler already classified it as ad_infra). Every resolve is logged as activity.

**Modes**:
- `mode: "resolve"` (default) — create missing, log activity, return rids
- `mode: "lookup"` — return existing rids only, no creates, no activity logging

### Step 2: Create Property List with Governance Filters

Scope3 creates a property list on its own governance agent, filtered by carbon requirements:

```json
{
  "tool": "create_property_list",
  "arguments": {
    "name": "Unilever Q3 Low Carbon — Display US/UK",
    "base_properties": [
      {
        "selection_type": "identifiers",
        "identifiers": [
          { "type": "domain", "value": "nytimes.com" },
          { "type": "domain", "value": "bbc.co.uk" },
          { "type": "domain", "value": "obscure-blog.com" }
        ]
      }
    ],
    "filters": {
      "countries_all": ["US", "UK"],
      "channels_any": ["display"],
      "feature_requirements": [
        { "feature_id": "carbon_score", "min_value": 85 }
      ]
    },
    "brand": { "domain": "unilever.com" }
  }
}
```

Of 499 valid domains (after excluding flashtalking.net), 347 pass the carbon threshold.

### Step 3: Layer Additional Governance

Optionally intersect with brand safety, consent, etc. from other governance agents:

```json
{
  "tool": "create_property_list",
  "arguments": {
    "name": "Unilever Q3 Brand Safety — Display US/UK",
    "base_properties": [{ "selection_type": "identifiers", "identifiers": [...] }],
    "filters": {
      "countries_all": ["US", "UK"],
      "channels_any": ["display"],
      "feature_requirements": [{ "feature_id": "brand_risk", "max_value": 20 }]
    },
    "brand": { "domain": "unilever.com" }
  }
}
```

347 low-carbon ∩ 412 brand-safe = 298 compliant domains.

### Step 4: Create TMP Package

```json
{
  "tool": "create_media_buy",
  "arguments": {
    "packages": [{
      "name": "Unilever Q3 Low Carbon Display",
      "property_list_ref": {
        "agent_url": "https://api.scope3.com",
        "list_id": "pl_unilever_q3_carbon",
        "auth_token": "eyJ..."
      },
      "budget": { "amount": 500000, "currency": "USD" },
      "flight": { "start": "2026-07-01", "end": "2026-09-30" }
    }]
  }
}
```

When a publisher in the compliant list sends a TMP context-match request with their `property_rid`, the router matches it against this package.

### The Loop

```
Advertiser gives Scope3 500 domains
  → Resolve: 498 properties, 1 ad_infra excluded, 1 unclassified queued
    → Property list with carbon filter: 347 pass
      → Layer brand safety: 298 pass
        → TMP package targeting 298 property_rids
          → Publishers send context-match with their property_rid
            → Router matches rid against package's property list
```

## Data Model

### `catalog_facts` Table

The source of truth. Every assertion about the property universe, from any pipeline.

```sql
CREATE TABLE catalog_facts (
  fact_id UUID PRIMARY KEY,              -- UUID v7
  fact_type TEXT NOT NULL,               -- identity, linking, classification, ownership
  subject_type TEXT NOT NULL,            -- identifier, property_rid
  subject_value TEXT NOT NULL,
  predicate TEXT NOT NULL,               -- exists, same_property_as, classified_as, owned_by, has_identifier, etc.
  object_value TEXT,                     -- the assertion value
  source TEXT NOT NULL,                  -- adagents_json, app_store, ads_txt, web_crawl, member_resolve, addie_analysis
  confidence TEXT NOT NULL,              -- authoritative, strong, medium, weak
  actor TEXT NOT NULL,                   -- pipeline name, member_id, 'system'
  provenance_type TEXT,                  -- for member_resolve: agency_allowlist, impression_log, etc.
  provenance_context TEXT,               -- optional annotation
  superseded_by UUID,                    -- if this fact has been replaced by a stronger one
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ                 -- for time-limited facts (e.g., app store data refreshes weekly)
);

CREATE INDEX idx_facts_subject ON catalog_facts(subject_type, subject_value);
CREATE INDEX idx_facts_source ON catalog_facts(source, created_at);
CREATE INDEX idx_facts_type ON catalog_facts(fact_type, created_at);
```

### `catalog_properties` Table

Materialized current state. One row per addressable property.

```sql
CREATE TABLE catalog_properties (
  property_rid UUID PRIMARY KEY,         -- UUID v7, generated in application
  property_id TEXT,                      -- publisher slug from adagents.json, null for contributed
  classification TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN ('property', 'ad_infra', 'publisher_mask', 'network', 'unclassified')),
  source TEXT NOT NULL CHECK (source IN ('authoritative', 'enriched', 'contributed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'removed')),
  adagents_url TEXT,                     -- where the authoritative adagents.json lives (null = registry-managed)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_catalog_updated_at ON catalog_properties(updated_at);
CREATE INDEX idx_catalog_classification ON catalog_properties(classification) WHERE classification = 'property';
```

### `catalog_identifiers` Table

Maps identifiers to properties. Many-to-one.

```sql
CREATE TABLE catalog_identifiers (
  id UUID PRIMARY KEY,                    -- UUID v7
  property_rid UUID NOT NULL REFERENCES catalog_properties(property_rid),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  evidence TEXT NOT NULL,                 -- adagents_json, app_store, member_resolve, addie_analysis
  confidence TEXT NOT NULL,               -- authoritative, strong, medium, weak
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(identifier_type, identifier_value),
  CONSTRAINT chk_identifier_lowercase CHECK (identifier_value = lower(identifier_value))
);

CREATE INDEX idx_identifiers_property ON catalog_identifiers(property_rid);
```

### `catalog_aliases` Table

When properties merge, old rids become aliases.

```sql
CREATE TABLE catalog_aliases (
  alias_rid UUID PRIMARY KEY,
  canonical_rid UUID NOT NULL REFERENCES catalog_properties(property_rid),
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence TEXT NOT NULL,
  actor TEXT NOT NULL
);
```

The resolve endpoint checks aliases transparently. Permanent — never expires.

### `catalog_activity` Table

Resolve call log. Append-only. Partitioned by month.

```sql
CREATE TABLE catalog_activity (
  id UUID NOT NULL,                       -- UUID v7
  property_rid UUID NOT NULL,
  member_id TEXT NOT NULL,
  provenance_type TEXT NOT NULL,
  provenance_context TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (resolved_at);

CREATE INDEX idx_activity_property_member
  ON catalog_activity(property_rid, member_id, provenance_type) INCLUDE (resolved_at);
CREATE INDEX idx_activity_member ON catalog_activity(member_id);
CREATE INDEX idx_activity_time_property ON catalog_activity(resolved_at, property_rid);
```

### Materialized View for Analytics

```sql
CREATE MATERIALIZED VIEW catalog_activity_daily AS
SELECT
  property_rid, member_id, provenance_type,
  date_trunc('day', resolved_at) AS resolve_date,
  count(*) AS resolve_count
FROM catalog_activity
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX idx_activity_daily_pk
  ON catalog_activity_daily(property_rid, member_id, provenance_type, resolve_date);
```

## API

### `POST /api/registry/resolve`

The primary endpoint. Takes identifiers, returns `property_rid`s. Auto-creates missing entries (in `resolve` mode). Excludes ad_infra/masks. Logs activity.

- `mode: "resolve"` (default) — create missing, log activity, return rids
- `mode: "lookup"` — return existing rids only, no creates, no activity logging

### `GET /api/registry/catalog`

Browse the full universe. Filters: `classification`, `source`, `status`, `identifier_type`, `search`, `min_resolves`, `active_since`. Cursor-based pagination.

### `GET /api/registry/catalog/sync`

For TMP participants syncing locally. Returns entries created or updated since `server_timestamp`. Response includes `server_timestamp` for next sync (avoids clock skew).

### `GET /api/registry/catalog/{identifier}/activity`

Activity history for a specific property: who resolved it, when, from what provenance.

## Identifier Normalization

Before storage or lookup:

| Identifier Type | Normalization |
|----------------|---------------|
| `domain` | Lowercase, strip protocol, strip trailing dot, strip `www.` prefix |
| `subdomain` | Lowercase, strip protocol, strip trailing dot |
| `ios_bundle` | Lowercase |
| `android_package` | Lowercase |
| `rss_url` | Lowercase scheme and host, preserve path |
| All others | Lowercase |

Database enforces lowercase via check constraint.

## Catalog Growth Management

1. **Classification gate**: ad_infra and publisher_mask identifiers never get a rid.
2. **DNS validation**: Contributed domains must resolve in DNS. App identifiers validated against store APIs where feasible.
3. **Batch size limits**: By membership tier. Free: 500/call. Paid: 10K/call.
4. **Staleness**: Properties with no resolve activity in 90 days marked `stale`. Excluded from browse/sync by default. Resolvable (which reactivates them). The rid is forever.

## Relationship to TMP

### Catalog as Shared Namespace

Both sides sync from the catalog at planning time:
- **Buyer** resolves identifiers → gets rids → builds property lists → creates packages (set of rids).
- **Publisher** syncs properties from catalog → gets their rids → uses in TMP context-match requests.
- **Router** matches: is this rid in any active package's property list? Set membership. No runtime catalog calls.

### TMP Wire Format (Phased Rollout)

**Phase 1**: `property_rid` optional on context-match request. Router resolves from its local catalog cache when absent.

```json
{
  "request_id": "req_abc",
  "property_id": "homepage",
  "property_rid": "019539a0-b1c2-7d3e-8f4a-5b6c7d8e9f0a",
  "property_type": "website",
  "placement_id": "above_fold_1",
  "available_packages": [...]
}
```

**Phase 2** (catalog adoption >80%): Deprecate fallback. Log warnings when missing.
**Phase 3**: `property_rid` required. `property_id` stays on wire for logging/debugging.

## What This Does NOT Change

- **`adagents.json` remains authoritative** for authorization
- **Scores stay private** — the catalog stores no scores or feature data
- **Property lists stay buyer-private**

## Bootstrap: Scope3 Seed

Scope3 has already built much of this for sustainability measurement:
- **Property aliasing** — mapping between domains, app bundles, and store IDs
- **Ad serving domain classification** — which domains are ad infrastructure vs. properties
- **Publisher mask identification** — which domains front multiple properties
- **Impression-to-property resolution** — resolving impression log domains to actual properties

Instead of building all six pipelines from scratch and growing the catalog organically, we seed it with Scope3's existing knowledge graph:

### Seed Phase

1. **Export Scope3's property graph** as facts:
   - Classification facts: every domain Scope3 knows is ad_infra, publisher_mask, or property
   - Linking facts: every known alias (domain ↔ app bundle ↔ store ID)
   - Identity facts: every property Scope3 can score (100K+ domains)

2. **Ingest as `source: contributed, confidence: strong`** — Scope3 has verified this data through years of impression analysis. Higher confidence than a typical member contribution, but not authoritative (only adagents.json is authoritative).

3. **Run adagents.json crawler over seeded domains** — upgrade contributed properties to authoritative where publishers have deployed adagents.json. This immediately validates and enriches a large chunk of the seed data.

4. **Run ads.txt crawler over seeded domains** — corroborate Scope3's ad_infra classifications with ads.txt evidence. Where they agree, confidence goes up. Where they disagree, flag for review.

### Transition Phase

Once seeded, Scope3 switches to using the AAO catalog as primary:

1. **Resolve calls go to the catalog** instead of Scope3's internal property DB
2. **New properties discovered** by Scope3 (from impression logs, agency allowlists) get contributed to the catalog via the resolve endpoint
3. **Classification updates** from Scope3's ongoing analysis feed back as facts
4. **Linking discoveries** (new app bundles for known properties, etc.) feed back as facts

Scope3's internal property DB becomes a cache of the catalog, not the source of truth. The catalog grows from Scope3's seed + other members' contributions + pipeline discoveries.

### Why This Works

- **Scope3 gets a better property graph** — other members' contributions and the catalog's pipelines enrich what Scope3 already knows
- **AAO gets instant scale** — the catalog launches with 100K+ classified properties instead of growing from zero
- **Other members benefit immediately** — when DoubleVerify or IAS joins, they find a comprehensive catalog already populated
- **The bootstrap is the proof case** — if Scope3 can migrate to the catalog as primary, the design works

### Pipeline Build Order (Revised)

1. **Catalog data model + resolve endpoint** — the foundation (done)
2. **Scope3 seed ingestion** — bulk import of existing graph (classifications, aliases, identifiers)
3. **adagents.json crawler upgrade** — run over seeded domains, upgrade contributed → authoritative
4. **ads.txt classifier** — corroborate Scope3's ad_infra classifications, flag disagreements
5. **Tranco corroboration** — load as in-memory lookup, validate seeded domains have real traffic
6. **App store crawler** — maintain and extend identifier linking facts (bundle ↔ store ID)
7. **Member resolve endpoint** — open to other members
8. **Addie enrichment** — intelligence layer for unclassified properties, prioritized by demand signals

Key sequencing decision: Scope3 seed first, THEN validate with crawlers. Not the other way around. The crawlers are validation/corroboration layers on top of the seed data — they don't produce enough useful data on their own to justify running them against the entire internet.

## Open Questions

1. **Seed data format** — What's the most efficient way to export Scope3's graph? Fact-level JSONL? Or higher-level (properties + identifiers + classifications) that gets decomposed into facts on ingestion?
2. **Confidence calibration** — Scope3's seed data is stronger than a typical member contribution but not authoritative. `strong` confidence seems right. Should there be a `seed` source distinct from `member_resolve`?
3. **Linking without adagents.json** — When two identifiers from different members appear to be the same property but there's no adagents.json or app store link, what's the merge process? Human review queue? Confidence threshold? Never auto-merge below `strong`?
4. **Domain re-registration** — When a domain expires and gets re-registered, how do we detect it? The old rid must be deactivated and a new one created.
5. **Fact storage scale** — The fact table grows fast. Partitioning strategy? Retention policy for superseded facts?
6. **Membership gate** — Must you be a paying member to resolve? Resolving grows the catalog (good), but ungated access invites abuse.
