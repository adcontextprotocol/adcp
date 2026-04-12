# Collection Lists

**Status**: Draft

## Problem

A CTV brand safety "do not air" list contains three kinds of exclusions:

1. **Properties** — apps and platforms to avoid entirely. Property lists handle this today.
2. **Programs** — specific shows to avoid regardless of platform. No mechanism exists for this.
3. **Content categories** — genres and ratings to avoid (TV-MA, News, Kids). These are show-level attributes, but the only current home is content standards, which operates at the per-artifact adjacency level.

The gap is #2 and the structural part of #3. A buyer needs to say "exclude these programs across all sellers" and "exclude all TV-MA collections" as reusable, setup-time artifacts — the same way property lists work for properties.

Collections already exist in AdCP (`collection.json`): they have genre, content_rating, distribution identifiers (imdb_id, gracenote_id), and are declared in `adagents.json`. But there's no list construct for them, no way to reference them in targeting, and no registry identity for cross-publisher matching.

## Core Insight

Programs are independent of properties. A hit comedy series airs on multiple streaming platforms, free ad-supported services, and cable syndication simultaneously. Excluding it means excluding a single logical entity distributed across many sellers and properties. This is fundamentally different from property lists, which operate on technical surfaces.

Collection lists are to programs what property lists are to properties: a managed, cacheable, reusable artifact that expresses "these collections, filtered by these criteria."

## Design Principles

1. **Collections are independent of properties.** A collection list doesn't care where a program airs — it identifies the program itself. The seller resolves which of their inventory matches.
2. **Rating and genre are collection attributes, not content adjacency.** "Exclude TV-MA" is a show-level filter applied at setup time. "Exclude articles about violence adjacent to this ad" is content standards. Different abstraction levels, different evaluation times.
3. **Distribution identifiers are the cross-publisher key.** IMDb IDs, Gracenote IDs, and EIDR IDs already solve the "same show, different platforms" problem. Collection lists use them.
4. **Setup-time, not bid-time.** Like property lists, collection lists are resolved once, cached by sellers, and used in delivery decisions without runtime calls.
5. **Governance agents manage collection lists.** The same agent that manages a brand's property list manages their collection list. Both are brand safety artifacts.

## Architecture

### Three Layers of Brand Safety

| Layer | Construct | Abstraction | Evaluation Time | Example |
|-------|-----------|-------------|-----------------|---------|
| Property | Property list | Where ads run (apps, sites) | Setup | "Not on this news app" |
| Collection | Collection list | What content ads run in/around (shows, series) | Setup | "Not in this crime drama" |
| Content | Content standards | What specific content is adjacent | Per-impression | "Not next to kids content, but G/PG animation OK" |

These three layers compose. A media buy can reference all three:
- Property list: approved CTV apps
- Collection list: excluded programs
- Content standards: contextual adjacency rules

### Relationship to Content Standards

Content standards evaluate individual artifacts (articles, episodes, pages) against a natural language policy with calibration exemplars. They handle nuance: "ALWAYS EXCLUDE Kids programming" + "Animation/cartoons rated G or PG are permitted" is a contradiction that requires contextual judgment. Content standards can resolve it because they evaluate each piece of content individually.

Collection lists don't evaluate content. They filter by declared metadata — genre tags, content ratings, distribution identifiers. "Exclude all collections rated TV-MA" is a structural filter. "Exclude kids content except G/PG animation" is a content standards policy.

The boundary: if it can be decided from the collection's declared metadata alone, it's a collection list filter. If it requires evaluating actual content, it's content standards.

## The Collection List Object

```json
{
  "list_id": "cl_novamotors_ctv_dna_2026",
  "name": "Nova Motors CTV Do Not Air — 2026",
  "description": "Programs excluded from Nova Motors CTV advertising per Pinnacle brand safety guidelines",
  "principal": "ops@pinnacleagency.com",

  "base_collections": [
    {
      "selection_type": "distribution_ids",
      "identifiers": [
        { "type": "imdb_id", "value": "tt9999901" },
        { "type": "gracenote_id", "value": "SH000001" }
      ]
    },
    {
      "selection_type": "publisher_collections",
      "publisher_domain": "titanstreaming.com",
      "collection_ids": ["danger_zone", "wild_nights"]
    }
  ],

  "filters": {
    "content_ratings_exclude": [
      { "system": "tv_parental", "rating": "TV-MA" }
    ],
    "genres_exclude": ["news", "kids"],
    "genre_taxonomy": "iab_content_3.0",
    "kinds": ["series"]
  },

  "brand": { "domain": "novamotors.com" },
  "cache_duration_hours": 168,
  "created_at": "2026-04-07T12:00:00Z",
  "updated_at": "2026-04-07T12:00:00Z",
  "collection_count": 247
}
```

### Base Collection Sources

Like property lists, collection lists start with a base set and apply filters. Three selection patterns, using the same discriminated union approach:

**distribution_ids** — Select collections by platform-independent identifiers. The primary mechanism for cross-publisher exclusion — an IMDb ID identifies a program regardless of which CTV platform carries it.

```json
{
  "selection_type": "distribution_ids",
  "identifiers": [
    { "type": "imdb_id", "value": "tt9999901" },
    { "type": "gracenote_id", "value": "SH000001" },
    { "type": "eidr_id", "value": "10.5240/XXXX-XXXX-XXXX-XXXX-XXXX-C" }
  ]
}
```

**Gracenote ID guidance:** Use root-level IDs for collection lists — SH-prefixed for series, MV-prefixed for movies, SP-prefixed for sports programs. Do not use EP-prefixed episode IDs in collection lists; episode-level exclusion is a content standards concern.

**publisher_collections** — Select specific collections within a publisher's `adagents.json`. Equivalent to `publisher_ids` on property lists. Use when the publisher's internal collection IDs are known.

```json
{
  "selection_type": "publisher_collections",
  "publisher_domain": "titanstreaming.com",
  "collection_ids": ["danger_zone", "wild_nights"]
}
```

**publisher_genres** — Select all collections from a publisher matching genre/rating criteria. Use when excluding entire content categories from a specific publisher.

```json
{
  "selection_type": "publisher_genres",
  "publisher_domain": "streamhaus.com",
  "genres": ["news"],
  "genre_taxonomy": "iab_content_3.0"
}
```

When `base_collections` is omitted, the list applies filters against the seller's entire collection inventory.

### Collection List Filters

Filters narrow the resolved list. Applied after base collection selection.

| Filter | Type | Logic | Description |
|--------|------|-------|-------------|
| `content_ratings_exclude` | ContentRating[] | OR (exclude any match) | Exclude collections with any of these ratings |
| `content_ratings_include` | ContentRating[] | OR (include any match) | Include only collections with these ratings |
| `genres_exclude` | string[] | OR (exclude any match) | Exclude collections tagged with any of these genres |
| `genres_include` | string[] | OR (include any match) | Include only collections with any of these genres |
| `genre_taxonomy` | string | — | Taxonomy for genre filter values (e.g., `iab_content_3.0`) |
| `kinds` | string[] | OR | Filter to collection kinds (series, publication, event_series, rotation) |
| `exclude_distribution_ids` | DistributionIdentifier[] | OR | Always exclude collections with these distribution IDs |
| `production_quality` | string[] | OR | Filter by production quality (professional, prosumer, ugc) |

**Include vs. exclude semantics:** Include filters are allowlists — only matching collections pass. Exclude filters are blocklists — matching collections are removed. When both are present for the same dimension (e.g., `genres_include` and `genres_exclude`), include is applied first, then exclude narrows further.

**Filter interaction example:** A list with `genres_include: ["drama", "comedy"]` and `genres_exclude: ["crime"]` first includes only drama and comedy collections, then removes any tagged as crime. A collection tagged `["drama", "crime"]` would be excluded — the exclude filter wins over the include. A collection tagged `["comedy"]` passes. A collection tagged `["sports"]` is excluded by the include filter (not in the allowed set).

**Content rating filters vs. content standards:** `content_ratings_exclude: [{ system: "tv_parental", rating: "TV-MA" }]` excludes all collections declared as TV-MA. This is a metadata filter on the collection's `content_rating` field. It doesn't evaluate episode content — an individual episode rated differently than the series baseline is the content standards layer's job.

### Resolved List Format

When a collection list is fetched, the response includes resolved collection entries:

```json
{
  "list_id": "cl_novamotors_ctv_dna_2026",
  "name": "Nova Motors CTV Do Not Air — 2026",
  "resolved_at": "2026-04-07T14:00:00Z",
  "cache_valid_until": "2026-04-14T14:00:00Z",
  "collection_count": 247,
  "collections": [
    {
      "collection_rid": "019abc12-...",
      "name": "Danger Zone",
      "distribution_ids": [
        { "type": "imdb_id", "value": "tt9999901" },
        { "type": "gracenote_id", "value": "SH000001" }
      ],
      "content_rating": { "system": "tv_parental", "rating": "TV-MA" },
      "genre": ["comedy", "animation"],
      "kind": "series"
    }
  ],
  "cursor": null
}
```

Resolved entries use `collection_rid` (from the registry) as the stable identifier. Sellers match incoming collection lists against their own collections using distribution identifiers and/or collection_rids.

## Collection Registry

### The Problem

Collections today are declared per-publisher in `adagents.json`. The same program on two different streaming platforms is two independent `collection_id` strings with no guaranteed relationship. Distribution identifiers (imdb_id, gracenote_id) solve identity for known programs, but there's no shared namespace.

The property registry assigns `property_rid`s to properties for cross-publisher matching. Collections need the same: a `collection_rid` that means "this program" regardless of where it airs.

**Terminology note:** The collection registry is part of the broader AdCP registry infrastructure alongside the property registry. It is distinct from `sync_catalogs`, which is a seller-side task for syncing product catalogs (store feeds, SKU data) into a media buy. The collection registry is a shared namespace for content programs; `sync_catalogs` is a per-seller data pipeline for commerce inventory.

### Extension to the Property Registry

The property registry's fact-graph model extends naturally to collections:

- **A collection is a content entity** with distribution identifiers (imdb_id, gracenote_id, eidr_id) as its primary keys
- **Multiple publishers distribute the same collection** — each publisher's `adagents.json` declares their local `collection_id`, linked to the canonical `collection_rid` via distribution identifiers
- **The registry resolves distribution identifiers to collection_rids** the same way it resolves domain/bundle identifiers to property_rids

### New Tables

```sql
CREATE TABLE registry_collections (
  collection_rid UUID PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('series', 'publication', 'event_series', 'rotation')),
  genre TEXT[],
  genre_taxonomy TEXT,
  content_rating_system TEXT,
  content_rating TEXT,
  language TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'hiatus', 'ended', 'upcoming')),
  source TEXT NOT NULL CHECK (source IN ('authoritative', 'enriched', 'contributed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```sql
CREATE TABLE registry_collection_identifiers (
  id UUID PRIMARY KEY,
  collection_rid UUID NOT NULL REFERENCES registry_collections(collection_rid),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(identifier_type, identifier_value)
);

CREATE INDEX idx_coll_identifiers_rid ON registry_collection_identifiers(collection_rid);
```

```sql
CREATE TABLE registry_collection_distributions (
  id UUID PRIMARY KEY,
  collection_rid UUID NOT NULL REFERENCES registry_collections(collection_rid),
  property_rid UUID NOT NULL REFERENCES catalog_properties(property_rid),
  publisher_collection_id TEXT,
  evidence TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection_rid, property_rid)
);

CREATE INDEX idx_coll_dist_property ON registry_collection_distributions(property_rid);
```

The `registry_collection_distributions` table links collections to the properties they're distributed on — "Danger Zone (collection_rid X) is available on Titan Streaming (property_rid Y)." This is the join table that lets sellers match a buyer's collection list against their own inventory.

### Resolve Endpoint

```
POST /api/registry/collections/resolve
```

```json
{
  "identifiers": [
    { "type": "imdb_id", "value": "tt9999901" },
    { "type": "gracenote_id", "value": "SH000001" }
  ],
  "mode": "resolve"
}
```

Response:

```json
{
  "resolved": [
    {
      "identifier": { "type": "imdb_id", "value": "tt9999901" },
      "collection_rid": "019abc12-...",
      "name": "Danger Zone",
      "status": "existing"
    }
  ]
}
```

### Fact Sources for Collections

| Source | What It Discovers | Confidence |
|--------|-------------------|------------|
| `adagents.json` crawler | Publisher-declared collections with distribution IDs | Authoritative |
| App store metadata | Show/series metadata within CTV app listings | Strong |
| IMDb/Gracenote/EIDR | Canonical program metadata | Authoritative (for identity) |
| Member resolve calls | "This IMDb ID is a program we need to target" | Medium |
| Addie enrichment | Genre, rating, status analysis | Medium |

The `adagents.json` crawler is the richest source — publishers who declare collections with `distribution` entries automatically populate the registry with cross-publisher identity.

## Targeting Integration

### Collection List Reference

Parallel to `property-list-ref.json`:

```json
{
  "agent_url": "https://governance.pinnacleagency.com",
  "list_id": "cl_novamotors_ctv_dna_2026",
  "auth_token": "eyJ..."
}
```

### In Targeting Overlays

Two fields in `targeting.json` support both inclusion and exclusion:

```json
{
  "property_list": {
    "agent_url": "https://governance.pinnacleagency.com",
    "list_id": "pl_novamotors_approved_ctv"
  },
  "collection_list_exclude": {
    "agent_url": "https://governance.pinnacleagency.com",
    "list_id": "cl_novamotors_dna_2026"
  }
}
```

| Field | Semantics | Use case |
|---|---|---|
| `collection_list` | Inclusion — only run in these collections | "Only buy pre-roll on these three shows" |
| `collection_list_exclude` | Exclusion — never run in these collections | Brand safety do-not-air lists |

A media buy can reference both simultaneously: "run in these approved shows, but never in these specific programs even if they appear on the approved list." The exclude list always wins when there's overlap.

**Why collection lists have both include and exclude in targeting but property lists only have include:** Property lists were designed before the include/exclude pattern was established across other targeting dimensions (geo, audience, device). Collection lists follow the current pattern. A future protocol evolution may add `property_list_exclude` for symmetry.

For product-level collection targeting (seller declares which collections are available), use `collection_targeting_allowed: true` on the product with collection selectors — this is the existing product-level mechanism.

### Seller Resolution Flow

When a seller receives a media buy with a `collection_list` reference:

1. Fetch and cache the collection list from the governance agent
2. Match list entries against their own collection inventory:
   - By `collection_rid` (if both sides use the registry)
   - By distribution identifiers (imdb_id, gracenote_id) as fallback
   - By `publisher_collections` entries matching their domain
3. Exclude matched collections from delivery
4. Apply content rating and genre filters from the list against their collection metadata
5. Report unmatched entries (programs the seller doesn't carry) in the response

### Validation

Sellers SHOULD validate collection lists at buy creation time and report:
- **matched_count**: How many list entries match their inventory
- **unmatched_entries**: List entries they can't resolve (unknown programs)
- **filtered_count**: How many additional collections excluded by rating/genre filters

## Operations

Collection list CRUD follows the same pattern as property lists:

| Task | Description |
|------|-------------|
| `create_collection_list` | Create a new collection list |
| `get_collection_list` | Fetch a collection list with resolved entries |
| `update_collection_list` | Modify base collections or filters |
| `list_collection_lists` | List collection lists for a principal |
| `delete_collection_list` | Remove a collection list |

## Buyer Agent Walkthrough

When an agency sends a CTV "do not air" list, the buyer agent should:

1. **Parse the list** into three buckets: properties, programs, content categories
2. **Resolve program identifiers** — look up IMDb/Gracenote IDs for named programs via the collection registry resolve endpoint
3. **Create a collection list** with resolved distribution identifiers + rating/genre filters
4. **Create or update the property list** with excluded apps
5. **Create or update content standards** for nuanced rules (e.g., the kids/animation boundary)
6. **Report back** with the mapping: which programs resolved, which need manual confirmation (programs where the distribution identifier wasn't found in the registry)

The collection registry makes step 2 possible at scale. Without it, the buyer agent has to search each seller's `adagents.json` individually to find collection IDs for a given program.

### Three-Layer Example

A beverage brand's CTV brand safety configuration:

**Property list** — excluded apps:

```json
{
  "tool": "create_property_list",
  "arguments": {
    "name": "Nova Motors CTV Excluded Apps",
    "base_properties": [
      {
        "selection_type": "identifiers",
        "identifiers": [
          { "type": "domain", "value": "crimenow.example.com" },
          { "type": "domain", "value": "latenighttv.example.com" }
        ]
      }
    ],
    "brand": { "domain": "novamotors.com" }
  }
}
```

**Collection list** — excluded programs + structural filters:

```json
{
  "tool": "create_collection_list",
  "arguments": {
    "name": "Nova Motors CTV Do Not Air — Programs",
    "base_collections": [
      {
        "selection_type": "distribution_ids",
        "identifiers": [
          { "type": "imdb_id", "value": "tt9999901" },
          { "type": "imdb_id", "value": "tt9999902" },
          { "type": "imdb_id", "value": "tt9999903" }
        ]
      }
    ],
    "filters": {
      "content_ratings_exclude": [
        { "system": "tv_parental", "rating": "TV-MA" }
      ],
      "genres_exclude": ["news"]
    },
    "brand": { "domain": "novamotors.com" }
  }
}
```

**Content standards** — nuanced contextual rules:

```json
{
  "tool": "create_content_standards",
  "arguments": {
    "name": "Nova Motors Content Standards — CTV",
    "channels_any": ["video"],
    "policy": "ALWAYS EXCLUDE: Kids and children's programming of any kind. EXCEPTION: Animation and cartoons rated G or PG by MPAA or TV-G/TV-PG by TV Parental Guidelines are PERMITTED when the content is not primarily targeted at children under 6. Evaluate the specific episode content, not just the series classification.",
    "calibration_exemplars": [
      {
        "artifact_url": "https://example.com/toddler-adventure-s3e5",
        "expected_result": "fail",
        "reason": "Children's programming targeted at preschoolers"
      },
      {
        "artifact_url": "https://example.com/animated-satire-s15e3",
        "expected_result": "pass",
        "reason": "Animation rated TV-PG, targets adult audience"
      }
    ]
  }
}
```

**Applied together in a media buy:**

```json
{
  "targeting": {
    "property_list": {
      "agent_url": "https://governance.pinnacleagency.com",
      "list_id": "pl_novamotors_approved_ctv"
    },
    "collection_list_exclude": {
      "agent_url": "https://governance.pinnacleagency.com",
      "list_id": "cl_novamotors_dna_2026"
    }
  }
}
```

Content standards are applied separately at the content evaluation layer — they don't need to be in the targeting overlay because they operate per-impression, not per-package.

**Composition is optional.** Most buyers will use one or two of the three layers, not all three. A buyer who only needs to exclude specific programs can use a collection list alone. A buyer who only cares about contextual adjacency can use content standards alone. The three-layer model is a composition framework, not a requirement.

## CTV Partner Mapping Patterns

CTV partners support different levels of exclusion granularity. Collection lists accommodate all of them:

- **Partners with program-level control** — Explicit collection entries via `distribution_ids` or `publisher_collections` map directly. The seller matches individual programs.
- **Partners with genre/category-level control** — Collection list genre and content rating filters map directly. The seller applies filters against their collection metadata.
- **Partners with app-level control only** — Property list entries handle these. Collection list entries for programs on these platforms are informational — the seller acknowledges them but may only be able to enforce at the app level.

For partners that support both levels, the collection list provides the complete picture: explicit program exclusions plus structural genre/rating filters that catch programs not individually listed.

## Live Sports Example

Live sports is the largest CTV brand safety concern — a car brand not wanting to appear during a controversial halftime show, or an alcohol brand needing to avoid youth-targeted sports programming. Collection lists handle live sports through the `event_series` kind:

```json
{
  "tool": "create_collection_list",
  "arguments": {
    "name": "Acme Outdoor — Excluded Sports Events",
    "base_collections": [
      {
        "selection_type": "distribution_ids",
        "identifiers": [
          { "type": "gracenote_id", "value": "SP000001" },
          { "type": "gracenote_id", "value": "SP000002" }
        ]
      }
    ],
    "filters": {
      "kinds": ["event_series"],
      "genres_exclude": ["combat_sports"],
      "genre_taxonomy": "gracenote"
    },
    "brand": { "domain": "acmeoutdoor.com" }
  }
}
```

This excludes specific sports programs by Gracenote ID (SP-prefixed for sports programs) and structurally excludes all combat sports event series. The `event_series` kind filter ensures the list only targets live event programming, not documentary series about sports.

Live sports collections have the same distribution identifier structure as scripted content — a championship league is identifiable by Gracenote or EIDR ID regardless of which streaming platform carries it.

## Schema Changes Summary

### New Schemas

| Schema | Location | Description |
|--------|----------|-------------|
| `collection-list.json` | `static/schemas/source/collection/` | Collection list object |
| `base-collection-source.json` | `static/schemas/source/collection/` | Discriminated union for collection sources |
| `collection-list-filters.json` | `static/schemas/source/collection/` | Filters for collection lists |
| `collection-list-ref.json` | `static/schemas/source/core/` | Reference to external collection list |
| `create-collection-list-request.json` | `static/schemas/source/collection/` | Create request |
| `create-collection-list-response.json` | `static/schemas/source/collection/` | Create response |
| `get-collection-list-request.json` | `static/schemas/source/collection/` | Get request |
| `get-collection-list-response.json` | `static/schemas/source/collection/` | Get response |
| `update-collection-list-request.json` | `static/schemas/source/collection/` | Update request |
| `update-collection-list-response.json` | `static/schemas/source/collection/` | Update response |
| `list-collection-lists-request.json` | `static/schemas/source/collection/` | List request |
| `list-collection-lists-response.json` | `static/schemas/source/collection/` | List response |
| `delete-collection-list-request.json` | `static/schemas/source/collection/` | Delete request |
| `delete-collection-list-response.json` | `static/schemas/source/collection/` | Delete response |

### Modified Schemas

| Schema | Change |
|--------|--------|
| `targeting.json` | Add `collection_list` (inclusion) and `collection_list_exclude` (exclusion) fields |
| `content-rating-system.json` | Add `chvrs` (Canada), `csa` (France), `pegi` (pan-European gaming) |

## Resolved Questions

1. **Include vs. exclude semantics in targeting.** Both supported. `collection_list` for inclusion, `collection_list_exclude` for exclusion. Follows the paired include/exclude pattern used by geo, audience, and device targeting fields.

2. **Genre taxonomy standardization.** Normalized via the `genre-taxonomy` enum: `iab_content_3.0`, `iab_content_2.2`, `gracenote`, `eidr`, `apple_genres`, `google_genres`, `roku`, `amazon_genres`, `custom`. The `publisher_genres` base collection source requires `genre_taxonomy` so sellers can interpret genre strings unambiguously.

3. **Rating system coverage.** Multiple systems supported via content-rating.json (system + rating). Added `chvrs` (Canada), `csa` (France), `pegi` (pan-European gaming) for international coverage alongside existing US, UK, Germany, Australia systems.

4. **Partial matches.** Coverage gaps approach from property lists replicated. The `get_collection_list` response includes a `coverage_gaps` field mapping dimension names to distribution identifiers for collections included despite missing metadata.

5. **Collection list webhooks.** Supported via `webhook_url` on the collection list and the `collection_list_changed` webhook schema.

## Open Questions

1. **Multiple lists per targeting field.** The current schema allows one `collection_list` and one `collection_list_exclude` per targeting overlay. In practice, governance is layered (brand list + agency list + trading desk list). A future evolution may accept arrays of refs.

2. **Collection registry bootstrap.** The collection registry (collection_rid for cross-publisher identity) is designed but not implemented. Entertainment metadata services (Gracenote, EIDR) are the natural seed sources. See `specs/collection-registry.md` (planned) for the full design.

3. **OpenRTB content signal alignment.** IAB Tech Lab's CTV Addressability Working Group is developing program-level signal specifications. When standardized, collection lists should adopt their identifier scheme. The `genre_taxonomy` enum descriptions include OpenRTB `cattax` integer mappings for the IAB taxonomies.
