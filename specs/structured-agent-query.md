# Structured Agent Query

## Problem

Buyers today can list agents with `GET /api/registry/agents?type=sales`, but that returns every sales agent in the registry. There is no way to filter by campaign profile — categories, markets, formats, property types. A buyer planning a CTV campaign in the US with IAB-7 (Entertainment) targeting has to probe every agent individually via `get_products` to find matches. This is expensive, slow, and doesn't scale as the registry grows.

## Goal

Buyers can query the registry for agents matching their campaign profile and get back a ranked list they can immediately send briefs to — including agents that registered yesterday.

```
GET /api/registry/agents/search?type=sales&categories=IAB-7&markets=US&channels=ctv
```

## Design

### Agent Inventory Profile

The registry materializes an **inventory profile** per agent from crawled data. This profile summarizes what an agent can sell without requiring callers to probe the agent directly.

Profile fields (all derived from crawled `adagents.json` + `get_products` data):

| Field | Source | Description |
|-------|--------|-------------|
| `channels` | Product `channels` array | Media channels (display, olv, ctv, dooh, etc.) |
| `property_types` | `discovered_properties.property_type` | Inventory surface types (website, mobile_app, ctv_app, etc.) |
| `markets` | `authorized_agents[].countries` in adagents.json | ISO 3166-1 alpha-2 country codes where agent is authorized |
| `categories` | `collections[].genre` in adagents.json | IAB Content Taxonomy 3.0 categories |
| `category_taxonomy` | `collections[].genre_taxonomy` | Taxonomy identifier (default: `iab_content_3.0`) |
| `format_ids` | Product `format_ids` array | Creative format identifiers the agent supports |
| `property_count` | Count of `discovered_properties` | Number of properties in the agent's inventory |
| `publisher_count` | Count of distinct `publisher_domain` | Number of publishers represented |
| `tags` | `discovered_properties.tags` union | Aggregated property tags |
| `has_tmp` | Product TMP config presence | Whether the agent supports Trusted Match Protocol |
| `delivery_types` | Product `delivery_type` | guaranteed, non_guaranteed, etc. |

### Database

```sql
CREATE TABLE agent_inventory_profiles (
  agent_url         TEXT PRIMARY KEY REFERENCES discovered_agents(agent_url),
  channels          TEXT[] NOT NULL DEFAULT '{}',
  property_types    TEXT[] NOT NULL DEFAULT '{}',
  markets           TEXT[] NOT NULL DEFAULT '{}',
  categories        TEXT[] NOT NULL DEFAULT '{}',
  category_taxonomy TEXT NOT NULL DEFAULT 'iab_content_3.0',
  format_ids        JSONB NOT NULL DEFAULT '[]',
  tags              TEXT[] NOT NULL DEFAULT '{}',
  delivery_types    TEXT[] NOT NULL DEFAULT '{}',
  property_count    INTEGER NOT NULL DEFAULT 0,
  publisher_count   INTEGER NOT NULL DEFAULT 0,
  has_tmp           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_profiles_channels ON agent_inventory_profiles USING GIN (channels);
CREATE INDEX idx_agent_profiles_markets ON agent_inventory_profiles USING GIN (markets);
CREATE INDEX idx_agent_profiles_categories ON agent_inventory_profiles USING GIN (categories);
CREATE INDEX idx_agent_profiles_property_types ON agent_inventory_profiles USING GIN (property_types);
```

GIN indexes on array columns enable `@>` (contains) queries for multi-value filters.

### Profile Population

Profiles are rebuilt after each crawl cycle in `CrawlerService.populateFederatedIndex`:

1. **From adagents.json** (already crawled):
   - `markets` ← `authorized_agents[].countries`
   - `categories` ← `collections[].genre` (with taxonomy)
   - `property_types` ← `properties[].property_type`
   - `tags` ← union of all `properties[].tags`

2. **From get_products** (optional, requires calling agent):
   - `channels` ← product `channels`
   - `format_ids` ← product `format_ids`
   - `delivery_types` ← product `delivery_type`
   - `has_tmp` ← presence of TMP config

3. **From discovered_properties** (already in DB):
   - `property_count` ← count of agent's authorized properties
   - `publisher_count` ← count of distinct publisher domains

Phase 1 uses only data from adagents.json and discovered_properties (no agent probing required). Phase 2 adds `get_products` data for agents that respond to capability discovery.

### Query Endpoint

```
GET /api/registry/agents/search
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | Agent type: sales, creative, signals |
| `channels` | string (CSV) | Filter by media channel: `ctv,olv` |
| `markets` | string (CSV) | Filter by ISO country code: `US,GB` |
| `categories` | string (CSV) | Filter by IAB category: `IAB-7,IAB-7-1` |
| `property_types` | string (CSV) | Filter by property type: `ctv_app,website` |
| `tags` | string (CSV) | Filter by property tag: `premium,news` |
| `delivery_types` | string (CSV) | Filter by delivery: `guaranteed` |
| `has_tmp` | boolean | Supports Trusted Match Protocol |
| `min_properties` | integer | Minimum property count |
| `sort` | string | Sort field: `property_count`, `publisher_count`, `relevance` (default) |
| `limit` | integer | Max results (default 50, max 200) |
| `cursor` | string | Pagination cursor |

All filters use AND logic. Multiple values within a filter use OR (e.g., `channels=ctv,olv` matches agents with CTV OR OLV inventory).

**Response:**

```json
{
  "agents": [
    {
      "url": "https://ads.streamhaus.example.com",
      "name": "StreamHaus Ad Sales",
      "type": "sales",
      "protocol": "mcp",
      "member": {
        "slug": "streamhaus",
        "display_name": "StreamHaus"
      },
      "inventory_profile": {
        "channels": ["ctv", "olv"],
        "property_types": ["ctv_app", "website"],
        "markets": ["US", "GB", "CA"],
        "categories": ["IAB-7", "IAB-7-1", "IAB-7-3"],
        "tags": ["premium", "entertainment"],
        "delivery_types": ["guaranteed", "non_guaranteed"],
        "property_count": 42,
        "publisher_count": 3,
        "has_tmp": true
      },
      "match": {
        "score": 0.92,
        "matched_filters": ["channels", "markets", "categories"]
      }
    }
  ],
  "count": 15,
  "next_cursor": "...",
  "filters_applied": {
    "channels": ["ctv"],
    "markets": ["US"],
    "categories": ["IAB-7"]
  }
}
```

### Ranking

When `sort=relevance` (default), agents are ranked by how well they match the query:

1. **Filter match breadth** — agents matching more filter dimensions rank higher
2. **Inventory depth** — more properties and publishers within matching criteria
3. **Freshness** — recently validated agents rank above stale profiles
4. **TMP support** — agents with TMP get a boost (important for buyer workflow)

The ranking is a simple weighted score, not ML. Weights can be tuned based on buyer feedback.

### Relationship to Existing Endpoints

- **`GET /api/registry/agents`** — remains the full listing endpoint with optional enrichment (health, capabilities, compliance). Unchanged.
- **`GET /api/registry/agents/search`** — the campaign-profile matching endpoint. Returns inventory profiles and match scores. Does not include health/capability enrichment (callers can fetch those separately for specific agents).
- The search endpoint uses the materialized `agent_inventory_profiles` table, so queries are fast (no live agent probing).

### Relationship to Change Feed and SDK

The change feed (see `specs/registry-change-feed.md`) keeps everything live:
- `agent.discovered` and `publisher.adagents_changed` events trigger profile rebuilds server-side.
- The `RegistrySync` SDK client (also in that spec) bootstraps from this search endpoint, then applies feed events incrementally. SDK users call `registry.agents.search(...)` against a local in-memory index — no network roundtrip.

The server-side search endpoint exists for consumers that don't use the SDK (curl, non-SDK agents, one-off queries). SDK users get the same query capability locally with zero latency.

## Implementation Phases

### Phase 1: Profile materialization + search endpoint
- Add `agent_inventory_profiles` table
- Populate from adagents.json data and discovered_properties (already crawled)
- Ship `GET /api/registry/agents/search` with array-contains filtering
- Basic relevance ranking

### Phase 2: Product-sourced profiles
- After crawl, call `get_products` on responsive agents
- Add `channels`, `format_ids`, `delivery_types`, `has_tmp` to profiles
- Add `channels` and `format_ids` as search filters

### Phase 3: Category hierarchy matching
- IAB Content Taxonomy 3.0 has a parent-child structure (IAB-7 → IAB-7-1, IAB-7-2, etc.)
- Query for `IAB-7` should match agents with `IAB-7-1` (child categories)
- Requires a category hierarchy table or in-code mapping
