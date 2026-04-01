# Registry Change Feed

## Problem

Buyers have no way to discover new agents or publishers joining the registry, or to know when existing `adagents.json` files change. The hourly crawler updates the registry's internal state, but there is no outward-facing mechanism for TMP participants to stay synchronized. Buyers must manually re-query the full catalog to detect changes, and publishers have no way to signal "my file just changed, re-crawl me now."

## Goals

1. Buyers can poll a single feed endpoint and maintain a near-real-time local copy of the registry.
2. Publishers/agents can trigger immediate re-crawl of their domain after updating `adagents.json`.
3. Optional webhook notifications reduce polling frequency for subscribers.

## Design Principles

- **Polling is the source of truth.** Webhooks are best-effort notifications, not guaranteed delivery.
- **Cursor-based, not timestamp-based.** UUID v7 event IDs are monotonically ordered and avoid clock-skew problems.
- **Events are denormalized.** Payload contains enough data for consumers to act without additional API calls.
- **Single unified feed.** Buyers care about downstream effects on property lists, not internal entity taxonomy.

---

## Event Model

### `catalog_events` Table

```sql
CREATE TABLE catalog_events (
  event_id        UUID PRIMARY KEY,
  event_type      TEXT NOT NULL,
  entity_type     TEXT NOT NULL,      -- property, agent, publisher, authorization
  entity_id       TEXT NOT NULL,      -- property_rid, agent_url, publisher_domain
  payload         JSONB NOT NULL,
  actor           TEXT NOT NULL,      -- crawler, member_id, system
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_catalog_events_created ON catalog_events(created_at);
CREATE INDEX idx_catalog_events_type ON catalog_events(event_type, created_at);
```

Append-only within a 90-day retention window.

### Event Types

| Event | Trigger | Why buyers care |
|-------|---------|-----------------|
| `property.created` | New property_rid assigned via resolve | New inventory to consider |
| `property.updated` | Classification, identifiers, or metadata changed | Property list membership may change |
| `property.merged` | Two rids merged (alias created) | Need to update local rid references |
| `property.stale` | 90-day resolve inactivity | May want to remove from active lists |
| `property.reactivated` | Stale property resolved again | Available inventory again |
| `agent.discovered` | New agent found via crawl or registration | New seller/creative/signals partner |
| `agent.removed` | Agent no longer in any adagents.json | Authorization may be revoked |
| `publisher.adagents_changed` | Crawl detects adagents.json diff | Properties, authorizations may have changed |
| `agent.profile_updated` | Inventory profile changed (new markets, channels, etc.) | Search results may change |
| `authorization.granted` | Agent authorized for publisher in adagents.json | New selling relationship; TMP routers must update |
| `authorization.revoked` | Agent removed from publisher's adagents.json | Selling relationship ended; TMP routers must update |

### Event Payload Examples

**property.created:**
```json
{
  "property_rid": "019539a0-b1c2-7d3e-8f4a-5b6c7d8e9f0a",
  "classification": "property",
  "source": "contributed",
  "identifiers": [
    { "type": "domain", "value": "example.com" }
  ]
}
```

**publisher.adagents_changed:**
```json
{
  "domain": "streamer.example.com",
  "properties_added": 2,
  "properties_removed": 0,
  "agents_added": ["https://ads.agency.example.com"],
  "agents_removed": []
}
```

**property.merged:**
```json
{
  "alias_rid": "019...",
  "canonical_rid": "019...",
  "evidence": "adagents_json"
}
```

**authorization.granted:**
```json
{
  "agent_url": "https://ads.agency.example.com",
  "publisher_domain": "streamer.example.com",
  "authorization_type": "property_ids",
  "property_ids": ["primetime_ctv", "news_live"],
  "placement_ids": ["pre_roll_30s", "mid_roll_15s"],
  "collections": [{ "publisher_domain": "streamer.example.com", "collection_id": "primetime_drama" }],
  "countries": ["US", "CA"],
  "delegation_type": "direct",
  "exclusive": false,
  "signing_keys": [{ "algorithm": "ed25519", "public_key": "base64..." }],
  "effective_from": "2026-04-01T00:00:00Z",
  "effective_until": "2027-03-31T23:59:59Z"
}
```

The authorization payload carries the full scoping model from `adagents.json` so `RegistrySync` clients can update their local `AuthorizationIndex` without fetching the full file. TMP routers consume these events to keep their hot-path authorization checks current.

---

## API Endpoints

### `GET /api/registry/feed`

Poll the change feed.

**Authentication:** Required. Member-only endpoint.

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cursor` | UUID | (none) | Last event_id processed. Omit for start of retention window. |
| `types` | string | all | Comma-separated event types. Supports glob: `property.*` |
| `limit` | integer | 1000 | Max events per response. Max 10000. |

**Response:**
```json
{
  "events": [
    {
      "event_id": "019539a0-...",
      "event_type": "property.created",
      "entity_type": "property",
      "entity_id": "019539a0-b1c2-...",
      "payload": { "..." : "..." },
      "created_at": "2026-03-31T10:00:00Z"
    }
  ],
  "next_cursor": "019539a1-...",
  "has_more": true
}
```

Consumers save `next_cursor` and pass it as `cursor` on the next poll. When `has_more` is false, the consumer is caught up.

### `POST /api/registry/crawl-request`

Publisher or authorized agent requests immediate re-crawl of a domain's `adagents.json`.

**Authentication:** Required. Requester must be either:
- A member whose profile includes the domain as a registered publisher, or
- An agent authorized for that domain (per `agent_publisher_authorizations`)

**Request:**
```json
{
  "domain": "publisher.example.com"
}
```

**Response (accepted):**
```json
{
  "status": "accepted",
  "domain": "publisher.example.com"
}
```

**Response (rate limited):**
```json
{
  "status": "rate_limited",
  "domain": "publisher.example.com",
  "last_crawled": "2026-03-31T09:55:00Z",
  "retry_after": 300
}
```

**Rate limit:** One re-crawl per domain per 10 minutes. Returns 429 if the domain was crawled within that window.

After the re-crawl completes, the crawler diffs previous state against new state and writes events to `catalog_events`. Those events flow to the feed and trigger webhook notifications.

### `POST /api/registry/webhooks`

Register a webhook subscription for change notifications.

**Authentication:** Required. One subscription per member (higher tiers may have more).

**Request:**
```json
{
  "url": "https://buyer.example.com/hooks/registry",
  "events": ["property.*", "agent.discovered"],
  "secret": "subscriber-provided-hmac-secret"
}
```

**Response:**
```json
{
  "subscription_id": "sub_...",
  "status": "active"
}
```

Additional CRUD endpoints:
- `GET /api/registry/webhooks` — list subscriptions
- `DELETE /api/registry/webhooks/:id` — remove subscription

### Webhook Delivery

Webhooks are notifications, not event delivery. The payload says "something changed, poll the feed."

```
POST https://buyer.example.com/hooks/registry
X-Registry-Signature: sha256={hmac}
X-Registry-Event: property.created

{
  "event_count": 3,
  "latest_event_id": "019...",
  "event_types": ["property.created", "property.updated"],
  "feed_url": "https://agenticadvertising.org/api/registry/feed?cursor=019..."
}
```

**Coalescing:** Events are batched per subscriber per 30-second window. A seed operation that creates 1000 properties produces one webhook notification, not 1000.

**Retries:** 3 attempts with exponential backoff (30s, 5m, 30m). After 3 consecutive failures, subscription marked `degraded`. After 24 hours of failures, marked `suspended` and subscriber notified via email.

---

## Event Production Points

Events are written at the point of change, not reconstructed later:

| Source | Events produced |
|--------|----------------|
| `CatalogDatabase.resolveIdentifiers` (resolve mode, property created) | `property.created` |
| `CatalogDatabase.linkIdentifier` (new link or override) | `property.updated` |
| `CatalogDatabase.mergeProperties` | `property.merged` |
| Crawler `populateFederatedIndex` (new agent discovered) | `agent.discovered` |
| Crawler diff (agent no longer in any adagents.json) | `agent.removed` |
| Crawler diff (adagents.json content changed) | `publisher.adagents_changed` |
| Crawler diff (authorization added/removed) | `authorization.granted`, `authorization.revoked` |
| Crawler diff (agent inventory profile changed) | `agent.profile_updated` |
| Catalog governance (dispute resolved, classification changed) | `property.updated` |
| Staleness cron (90-day inactivity) | `property.stale` |
| Resolve reactivation (stale property resolved) | `property.reactivated` |

**Seed operations** do not write individual events. A single `catalog.seed_complete` summary event is written. Consumers who need full state after a seed should use `/catalog/sync`.

---

## Consumer Pattern

1. **Bootstrap:** `GET /api/registry/catalog/sync?since=1970-01-01T00:00:00Z` with pagination for full property catalog.
2. **Steady state:** Poll `GET /api/registry/feed?cursor={last_event_id}` every 30-60 seconds, or wait for webhook notification and then poll.
3. **Recovery:** If cursor is older than 90 days (retention window), do another full sync via `/catalog/sync` and reset the cursor.

---

## Relationship to Existing Endpoints

- **`/catalog/sync`** remains the full-state sync mechanism for property-only data. The change feed is the incremental update mechanism that covers properties, agents, publishers, and authorizations.
- **`/registry/agents`** and **`/registry/publishers`** remain point-in-time query endpoints. The change feed tells you *when* things changed; the query endpoints tell you the *current state*.

---

## Client SDK: `RegistrySync`

The change feed and structured agent query are most useful when they disappear behind a client-side abstraction. SDK users should get an always-up-to-date in-memory replica with zero polling code.

This follows the existing `PropertyIndex` singleton pattern in `@adcp/client` — an in-memory index populated by the crawler. `RegistrySync` extends that pattern to the full registry (properties, agents, publishers, authorizations) and keeps it live via the change feed.

### Usage

**TypeScript:**
```typescript
import { RegistrySync } from '@adcp/client';

const registry = new RegistrySync({ apiKey: 'sk_...' });
await registry.start(); // bootstrap + begin polling

// Find sales agents for a CTV campaign in the US
const matches = registry.agents.search({
  type: 'sales',
  channels: ['ctv'],
  markets: ['US'],
  categories: ['IAB-7'],
});

// Get a specific agent's inventory profile
const agent = registry.agents.get('https://ads.streamhaus.example.com');

// Resolve a property
const property = registry.properties.getByRid('019539a0-...');
const property2 = registry.properties.getByIdentifier('domain', 'example.com');

// Who can sell this property?
const sellers = registry.properties.getAuthorizedAgents('domain', 'example.com');

// React to changes
registry.on('agent.discovered', (event) => {
  console.log(`New agent: ${event.entity_id}`);
});

// Graceful shutdown
registry.stop();
```

**Python:**
```python
from adcp import RegistrySync

registry = RegistrySync(api_key="sk_...")
await registry.start()

matches = registry.agents.search(
    type="sales",
    channels=["ctv"],
    markets=["US"],
    categories=["IAB-7"],
)

# Context manager for lifecycle
async with RegistrySync(api_key="sk_...") as registry:
    agents = registry.agents.search(type="sales")
```

**Go:**
```go
registry, err := adcp.NewRegistrySync(adcp.RegistrySyncConfig{
    APIKey: "sk_...",
})
defer registry.Stop()

matches := registry.Agents().Search(adcp.AgentSearchQuery{
    Type:       "sales",
    Channels:   []string{"ctv"},
    Markets:    []string{"US"},
    Categories: []string{"IAB-7"},
})
```

### How It Works

```
┌─────────────────────────────────────────────────┐
│  RegistrySync (client process)                  │
│                                                 │
│  ┌─────────────┐  ┌──────────┐  ┌───────────┐  │
│  │ AgentIndex   │  │ Property │  │ AuthIndex │  │
│  │ (in-memory)  │  │  Index   │  │           │  │
│  └──────▲───────┘  └────▲─────┘  └─────▲─────┘  │
│         │               │              │        │
│         └───────┬───────┴──────┬───────┘        │
│                 │              │                 │
│          ┌──────┴──────┐ ┌────┴────┐            │
│          │  Bootstrap  │ │  Feed   │            │
│          │  (one-time) │ │ Poller  │            │
│          └──────┬──────┘ └────┬────┘            │
└─────────────────┼─────────────┼─────────────────┘
                  │             │
    GET /catalog/sync    GET /registry/feed
    GET /registry/agents/search (bootstrap profiles)
```

1. **Bootstrap** (on `start()`):
   - Fetches full property catalog via `GET /catalog/sync?since=epoch` (paginated)
   - Fetches full agent list with inventory profiles via `GET /registry/agents/search` (paginated, no filters)
   - Builds in-memory indexes: properties by rid, properties by identifier, agents by url, agents by profile fields, authorizations by domain

2. **Steady state** (background poller):
   - Polls `GET /registry/feed?cursor={last_event_id}` every 30 seconds
   - Applies events to in-memory indexes incrementally
   - Emits typed events for subscribers (`on('agent.discovered', ...)`)

3. **Recovery**:
   - If cursor is older than 90 days, does a full re-bootstrap
   - If feed returns an error, retries with exponential backoff
   - Persists cursor to disk (configurable) so restarts resume from last position

### In-Memory Indexes

**AgentIndex** — enables the structured query from `specs/structured-agent-query.md` entirely client-side:

```typescript
interface AgentIndex {
  // Full-text search
  search(query: AgentSearchQuery): AgentMatch[];

  // Direct lookups
  get(url: string): AgentWithProfile | undefined;
  list(type?: AgentType): AgentWithProfile[];

  // Reverse lookups
  getForDomain(domain: string): AgentWithProfile[];
  getForProperty(identifierType: string, value: string): AgentWithProfile[];

  // Stats
  readonly count: number;
  readonly lastUpdated: Date;
}

interface AgentSearchQuery {
  type?: 'sales' | 'creative' | 'signals';
  channels?: string[];
  markets?: string[];
  categories?: string[];
  property_types?: string[];
  tags?: string[];
  has_tmp?: boolean;
  min_properties?: number;
}
```

**PropertyIndex** — extends the existing `PropertyIndex` from `@adcp/client` with catalog data:

```typescript
interface CatalogPropertyIndex {
  getByRid(rid: string): CatalogProperty | undefined;
  getByIdentifier(type: string, value: string): CatalogProperty | undefined;
  getAuthorizedAgents(type: string, value: string): AgentWithProfile[];
  search(query: string): CatalogProperty[];    // text search on identifiers
  readonly count: number;
}
```

### Configuration

```typescript
new RegistrySync({
  apiKey: 'sk_...',                       // required
  baseUrl: 'https://agenticadvertising.org', // default
  pollIntervalMs: 30_000,                // default 30s
  persistCursor: true,                   // persist cursor to disk
  cursorPath: '.adcp/registry-cursor',   // default
  onError: (err) => console.error(err),  // error callback
  types: ['property.*', 'agent.*'],      // optional event type filter
});
```

### TMP Authorization Validation

The TMP spec requires the router to validate that each buyer agent is authorized to receive requests for a given property, placement, and collection. This is a hot-path check on every context-match request — it cannot make a network call.

`RegistrySync` provides this directly. The authorization data from `adagents.json` is already in the local replica, including the full scoping model:

```typescript
// TMP router validates before fanning out to a buyer agent
const auth = registry.authorizations.check({
  agent_url: 'https://buyer.example.com',
  property_rid: '019539a0-...',
  placement_id: 'pre_roll_30s',
  collection_id: 'primetime_drama',
  country: 'US',
});

if (!auth.authorized) {
  // skip this agent for this request
}
```

The `AuthorizationIndex` evaluates the full adagents.json authorization model locally:

```typescript
interface AuthorizationIndex {
  // Hot-path check for TMP routers
  check(query: AuthorizationQuery): AuthorizationResult;

  // Discovery: which agents are authorized for this property?
  getAuthorizedAgents(propertyRid: string): AuthorizedAgent[];

  // Discovery: which placements can this agent sell on this property?
  getAuthorizedPlacements(agentUrl: string, propertyRid: string): string[];

  // Signing key lookup for TMP request verification
  getSigningKeys(agentUrl: string, publisherDomain: string): SigningKey[];
}

interface AuthorizationQuery {
  agent_url: string;
  property_rid?: string;          // catalog property rid
  property_id?: string;           // publisher's human-readable id
  placement_id?: string;          // from adagents.json placements
  placement_tags?: string[];      // match placements by tag
  collection_id?: string;         // from adagents.json collections
  country?: string;               // ISO 3166-1 alpha-2
  timestamp?: Date;               // for effective_from/effective_until window check
}

interface AuthorizationResult {
  authorized: boolean;
  authorization_type: string;     // property_ids, property_tags, publisher_properties, etc.
  delegation_type?: string;       // direct, delegated, ad_network
  exclusive?: boolean;
  signing_keys?: SigningKey[];    // publisher-attested keys for this agent
  reason?: string;                // why unauthorized (expired, wrong placement, etc.)
}
```

This means:
- **TMP routers** use `registry.authorizations.check()` on every request — O(1), no network.
- **Buyer agents** use `registry.authorizations.getAuthorizedAgents(rid)` at planning time to know who they'll receive requests from.
- **Signature verification** uses `registry.authorizations.getSigningKeys()` to get publisher-attested keys without hitting the registry API.

The change feed keeps all of this live. When a publisher updates their `adagents.json` (adding/removing an agent, changing placement scoping), the `publisher.adagents_changed` and `authorization.granted`/`authorization.revoked` events update the local authorization index within seconds.

### Design Decisions

- **Client-side search, not server roundtrip.** The `agents.search()` method runs against the local in-memory index. No network call. The server-side `GET /registry/agents/search` endpoint still exists for consumers that don't use the SDK (curl, non-SDK agents), but SDK users get instant local queries.

- **Bootstrap from search endpoint, not individual probes.** The initial load pulls agent inventory profiles from the server (which already materializes them from crawled data). The client never calls `get_products` on individual agents.

- **Cursor persistence optional.** For short-lived processes (serverless, CLI tools), skip persistence and re-bootstrap each time. For long-running buyer agents, persist the cursor so restarts are incremental.

- **Event emitter for reactivity.** Buyer agents can subscribe to specific event types and take action (e.g., "when a new CTV agent appears, automatically send my brief"). This is the "webhook but in-process" pattern.

- **Extends, doesn't replace, PropertyIndex.** The existing `PropertyIndex` singleton works for property→agent lookups from crawled adagents.json. `RegistrySync` adds catalog properties (with rids), agent inventory profiles, and live updates. Code using `getPropertyIndex()` continues to work.

### Relationship to Server Endpoints

| SDK Method | Server Endpoint (bootstrap) | Server Endpoint (updates) |
|------------|---------------------------|--------------------------|
| `registry.agents.search(...)` | `GET /registry/agents/search` | `GET /registry/feed` (agent events) |
| `registry.agents.get(url)` | `GET /registry/agents/search` | `GET /registry/feed` |
| `registry.properties.getByRid(rid)` | `GET /catalog/sync` | `GET /registry/feed` (property events) |
| `registry.properties.getByIdentifier(...)` | `GET /catalog/sync` | `GET /registry/feed` |
| `registry.authorizations.check(...)` | `GET /registry/agents/search` (includes auth data) | `GET /registry/feed` (authorization events) |
| `registry.authorizations.getSigningKeys(...)` | `GET /registry/agents/search` | `GET /registry/feed` |
| `registry.on('event', ...)` | — | `GET /registry/feed` |

---

## Implementation Phases

### Phase 1: Event log + feed endpoint
Add `catalog_events` table. Instrument `CatalogDatabase` and the crawler to write events. Ship `GET /api/registry/feed`. This alone solves the polling-based discovery problem.

### Phase 2: Agent inventory profiles + search endpoint
Add `agent_inventory_profiles` table (see `specs/structured-agent-query.md`). Populate from crawled data. Ship `GET /api/registry/agents/search`. This gives the bootstrap data for `RegistrySync`.

### Phase 3: SDK `RegistrySync` client
Ship `RegistrySync` in `@adcp/client` (TypeScript). Bootstrap from search + sync endpoints, poll the feed, maintain in-memory indexes. This is where buyers get the "just works" experience.

### Phase 4: Re-crawl trigger
Add `POST /api/registry/crawl-request`. Wire to the crawler for single-domain re-crawl. Closes the "publisher changed file → buyer sees it within minutes" loop.

### Phase 5: Go and Python SDKs
Port `RegistrySync` to the Go and Python clients with idiomatic APIs.

### Phase 6: Webhook subscriptions
Add subscription CRUD, delivery worker with coalescing, retry/suspension logic. Most operationally complex — ship after the feed endpoint and SDK have proven stable.
