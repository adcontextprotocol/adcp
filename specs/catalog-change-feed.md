# Catalog Change Feed

## Problem

Sales agents and signals agents publish catalogs (`get_products buying_mode: "wholesale"`, `get_signals discovery_mode: "wholesale"`) that consumers want to mirror locally. With wholesale enumeration alone, the only way to detect catalog changes is to re-fetch the entire catalog and diff. This produces three concrete problems:

1. **Cost and latency.** A storefront syncing N sources hits each agent's paginated catalog every poll interval, even when nothing has changed. Sellers absorb the load; consumers pay the latency.
2. **No fast-path for "just changed."** A seller who just updated a bundle's pricing has no way to tell consumers "re-fetch me now." Consumers see the change on the next polling interval — minutes to hours later — which is unacceptable for time-sensitive pricing changes (dayparting, makegood adjustments).
3. **No diff signal at all.** Even with full re-fetch, consumers must compare every product/signal field against a local snapshot to detect changes. There is no protocol-level "this product changed since you last saw it" primitive.

The registry already has a solved version of this problem in [`specs/registry-change-feed.md`](./registry-change-feed.md): UUID-v7 cursor-based event feed, optional webhook notifications, retention window, denormalized payloads. That spec covers properties, agents, publishers, and authorizations *at the registry level*. This spec covers the analogous mechanism *at the agent level* — for products and signals inside a single sales/signals agent's catalog.

The `catalog_version` conditional-fetch tokens on `get_products` / `get_signals` (the ETag-style probe added in v3.1) are a complementary cheap-probe mechanism for agents that don't implement the full feed. Consumers MAY use `catalog_version` to validate their cursor is still current without consuming feed bandwidth.

## Goals

1. Consumers can poll a single per-agent feed endpoint and maintain a near-real-time mirror of the agent's product and signal catalog without re-fetching unchanged inventory.
2. Sellers can trigger immediate notification to subscribers after a catalog mutation.
3. Optional webhook subscriptions reduce polling frequency, with delivery semantics consistent with the registry feed.
4. The mechanism is symmetric for sales agents (products) and signals agents (signals). Agents that are both publish both event families on one feed.
5. Backward-compatible: agents that don't implement the feed continue to work — consumers fall back to `wholesale` polling, optionally with `catalog_version` probes.

## Design Principles

- **Polling is the source of truth.** Webhooks are best-effort notifications; the feed is durable. Same posture as the registry feed.
- **Cursor-based, not timestamp-based.** UUID v7 event IDs are monotonically ordered and avoid clock-skew problems.
- **Events are denormalized.** Payload contains the post-change state of the entity, so consumers can update local state without a follow-up `get_products`/`get_signals` call.
- **One feed per agent.** A sales agent that also publishes signals exposes both event families on one feed. Consumers filter by event type.
- **Symmetric with the registry feed.** A consumer that already implements `RegistrySync` should be able to implement `CatalogSync` against an agent with minimal new code.

---

## Event Model

### Event Types

| Event | Trigger | Why consumers care |
|-------|---------|--------------------|
| `product.created` | New product added to the agent's catalog | New inventory available for composition / discovery |
| `product.updated` | Product metadata changed (name, description, formats, properties, targeting capabilities, measurement terms) | Storefront catalog needs re-render |
| `product.priced` | Pricing options changed (new option, removed option, price/floor change) | Composition layer must re-price; existing media buys unaffected (locked at `create_media_buy` time) |
| `product.removed` | Product no longer available | Remove from catalog; existing media buys honored per cancellation policy |
| `signal.created` | New signal added | New targeting/composition option |
| `signal.updated` | Signal metadata changed (description, coverage, deployments) | Re-render in consumer catalog |
| `signal.priced` | Signal pricing options changed | Composition layer must re-price |
| `signal.removed` | Signal no longer available | Remove from catalog |
| `catalog.bulk_change` | Agent performed a bulk operation that crosses the threshold below | Trigger consumer re-sync via wholesale enumeration rather than processing every event |

`catalog.bulk_change` is the "fast-forward" event. When a seller does a rate-card sweep that touches many products, the agent SHOULD emit one `catalog.bulk_change` event with a summary payload rather than per-entity events.

**Threshold.** Agents SHOULD emit `catalog.bulk_change` when a single operation affects **>5% of the catalog** *or* **>100 entities**, **whichever is smaller**. The dual condition prevents two failure modes: small agents flooding consumers with absolute-threshold events for every change (5% caps it), and large agents hiding catalog-wide rotations behind a high absolute threshold (100 caps it). Agents MAY emit `catalog.bulk_change` for smaller operations when they know consumers benefit from the fast-forward (e.g., a rate-card change touching one heavily-used product). Consumers MUST handle interleaved per-entity events and bulk_change events idempotently.

### Event Payload Examples

**`product.priced`:**

```json
{
  "product_id": "prod_premium_ctv_us",
  "pricing_options": [
    { "pricing_option_id": "po_cpm_v2", "model": "cpm", "cpm": 18.50, "currency": "USD" }
  ],
  "previous_pricing_option_ids": ["po_cpm_v1"],
  "applies_to": { "scope": "public" },
  "effective_at": "2026-06-01T00:00:00Z"
}
```

The post-change `pricing_options[]` is included in full. `previous_pricing_option_ids[]` lets consumers detect that `po_cpm_v1` was retired. `effective_at` lets the agent announce changes before they take effect (subject to the pre-announce rules below).

**`applies_to`** declares which cache layer this event affects. See [Cache layering and event scoping](#cache-layering-and-event-scoping) below. `*.priced` and `*.updated` MUST carry `applies_to`. Other events (`*.created`, `*.removed`, `catalog.bulk_change`) MAY carry it; absence means `{ "scope": "public" }`.

**`effective_at` and pre-announce.** An `effective_at` value in the future is a pre-announcement: the change is scheduled but not yet in effect. Consumers MAY use pre-announced events to warm caches but MUST NOT bind decisions against pre-announced pricing until the effective time has passed, and MUST re-verify (per Security Posture) post-effective. Sellers MAY retract a pre-announced change by emitting a follow-up `*.priced` event with the prior `pricing_option_id` restored before the original `effective_at`. Once the effective time passes without retraction, the change is committed and behaves as any post-fact event.

**`product.updated`:**

```json
{
  "product_id": "prod_premium_ctv_us",
  "changed_fields": ["format_ids", "performance_standards"],
  "applies_to": { "scope": "public" },
  "product": { "...full Product object..." }
}
```

`changed_fields[]` is advisory — consumers MAY use it for fine-grained re-render, but MUST be able to handle a full replacement of the entity.

**`product.removed`:**

```json
{
  "product_id": "prod_premium_ctv_us",
  "removal_reason": "withdrawn",
  "applies_to": { "scope": "public" }
}
```

`removal_reason` is OPTIONAL but RECOMMENDED. Values: `"withdrawn"` (seller-initiated removal, no resubmit path), `"cancellation"` (resource cancelled, may return), `"depublication"` (underlying property depublished — see `publisher.adagents_changed` in the registry feed), `"policy_takedown"` (governance-driven removal). Downstream consequences differ — in-flight buys honor existing cancellation policy regardless of reason, but storefront catalog UX differs (e.g., a `depublication` may surface "publisher offline" rather than "product removed").

**`signal.priced`:**

```json
{
  "signal_agent_segment_id": "sigagent_seg_4421",
  "signal_id": { "source": "catalog", "data_provider_domain": "acme-data.com", "id": "luxury_auto_intenders" },
  "pricing_options": [
    { "pricing_option_id": "po_cpm_2", "model": "cpm", "cpm": 2.75, "currency": "USD" }
  ],
  "previous_pricing_option_ids": ["po_cpm_1"],
  "applies_to": {
    "scope": "account",
    "account_ids": ["acct_acme_001", "acct_nova_002"]
  },
  "effective_at": "2026-06-01T00:00:00Z"
}
```

Account-scoped pricing change: only the listed accounts' overlays should invalidate; the public layer is unaffected. The seller MAY omit `account_ids` when the affected set is competitively sensitive — the per-subscriber scope filter (see API Endpoints §Per-caller scope filtering) ensures each subscriber sees only events for accounts they're authorized for.

**`catalog.bulk_change`:**

```json
{
  "summary": "Q3 2026 rate card refresh",
  "affected_entity_types": ["product"],
  "affected_count": 1480,
  "recommendation": "wholesale_resync",
  "applies_to": { "scope": "public" }
}
```

## Cache layering and event scoping

Sellers publish two notional layers: a **public layer** (rate-card / structural / unauthenticated view) and **per-account overlays** (custom deals, account-specific rate cards). The conditional-fetch path (`if_catalog_version` on `get_products` / `get_signals`) and the change feed are both layer-aware.

**Versions are scope-keyed.** A `catalog_version` token describes a state for one specific `cache_scope` value (`"public"` or `"account"`). Consumers cache `(scope, version)` pairs and present the matching token on the next request. See the response-field docs on `get_products.mdx` and `get_signals.mdx` for the request-shape details.

**Events carry `applies_to.scope`.** Two values:

| `applies_to.scope` | Meaning | Consumer action |
|---|---|---|
| `"public"` | Affects the seller's rate-card / structural layer. | Invalidate the public-layer cache for the entity; ALL account overlays referencing that public version are also stale. |
| `"account"` with `account_ids[]` | Affects specific account overlays. The seller is willing to name them. | Invalidate only the named accounts' overlays. Public layer unaffected. |
| `"account"` without `account_ids` | Affects specific accounts; seller withholds the list (competitive sensitivity). | The per-subscriber scope filter routes the event only to subscribers whose principal is in the affected set — receiving the event means "your principal's overlay is stale." Invalidate the receiving principal's overlay. |

**Cross-scope downgrade.** A seller MAY return `cache_scope: "public"` on an `if_catalog_version` request that previously had `cache_scope: "account"`. This signals "this account no longer has overrides; you can drop the overlay and reference the public layer." The change feed equivalent is a `*.priced` event with `applies_to: { "scope": "public" }` after a prior account-scoped event — consumers drop the account overlay on the affected entity.

**Most accounts at most sellers are public-layer.** Premium custom deals are the exception, not the rule. Consumers caching across N accounts at one seller will typically hold one public-layer cache and a small number of account overlays.

---

## API Endpoints

The change-feed endpoints live on the agent itself, not a central registry.

### `GET /catalog/events`

Poll the change feed.

**Authentication:** Required. The caller must be authorized to call `get_products` / `get_signals` in `wholesale` mode against this agent — same authorization principal, same scope filter.

**Per-caller scope filtering.** The feed MUST apply the same per-caller scope filter as the wholesale endpoint at event-emission time, not just at authentication. If the agent multi-tenants — multiple brand or operator principals share one agent — events that affect entities outside the caller's authorized scope MUST NOT appear in their feed response. This is a tenancy property, not an authorization property: a feed that authenticates but does not scope-filter leaks competitive intelligence (brand A sees brand B's `product.priced` events). Agents that cannot reliably scope events per-principal MUST NOT declare `catalog_change_feed.supported: true`.

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cursor` | UUID | (none) | Last `event_id` processed. Omit for start of retention window. |
| `types` | string | all | Comma-separated event types. Supports glob: `product.*` |
| `limit` | integer | 1000 | Max events per response. Max 10000. |

**Response:**

```json
{
  "events": [
    {
      "event_id": "019539a0-...",
      "event_type": "product.priced",
      "entity_type": "product",
      "entity_id": "prod_premium_ctv_us",
      "payload": { "...": "..." },
      "created_at": "2026-05-18T10:00:00Z"
    }
  ],
  "next_cursor": "019539a1-...",
  "has_more": true,
  "retention_window_days": 30
}
```

Retention is agent-declared via `catalog_change_feed.retention_window_days` in `get_adcp_capabilities` (SHOULD be 30 days; MUST NOT be less than 7). Consumers whose `cursor` is older than the retention window get a `RETENTION_EXPIRED` error (see `enums/error-code.json`) and MUST resync via wholesale enumeration. A malformed cursor returns `INVALID_REQUEST`; a cursor from a different agent returns `RETENTION_EXPIRED` (the consumer's local state is unrecoverable for this agent).

### `POST /catalog/subscriptions`

Register a webhook for change notifications. Optional — agents MAY refuse to implement webhooks and require polling.

**Request:**

```json
{
  "url": "https://storefront.example.com/hooks/catalog",
  "events": ["product.*", "signal.priced"],
  "secret": "subscriber-provided-hmac-secret"
}
```

**URL constraints (anti-SSRF).** Agents MUST validate the subscription URL at registration AND at each delivery attempt:

- Scheme MUST be `https`.
- Host MUST resolve to a public, routable address. Agents MUST reject hosts that resolve to RFC1918 / link-local / loopback / multicast / unique-local-IPv6 ranges, and MUST re-resolve DNS at delivery time (rebinding defense).
- Hostname MUST NOT be a metadata-service address (e.g., `169.254.169.254`, AWS/GCP/Azure equivalents) regardless of scheme.
- Agents SHOULD require a delivery-target challenge before activating a subscription: POST a one-time challenge token to the registered URL, expect the subscriber to echo it back at a known path (`/.well-known/adcp-catalog-webhook-challenge`). Closes the "register a victim URL to weaponize webhook fire against a third party" path.

**Per-subscription cap.** Agents MUST limit subscriptions per principal (RECOMMEND 10). Reject with `RATE_LIMITED` when exceeded.

**Subscription ownership.** Subscriptions are scoped to the creating principal. `GET /catalog/subscriptions` MUST return only the caller's own subscriptions. `DELETE /catalog/subscriptions/:id` MUST verify ownership before deletion. A compromised buyer principal MUST NOT be able to enumerate or delete other principals' subscriptions.

**Secret rotation.** Agents SHOULD support `PATCH /catalog/subscriptions/:id` with a new `secret` value and a rotation overlap window (default 5 minutes) during which both old and new signatures are accepted. Subscribers rotating leaked secrets MUST be able to do so without losing delivery in flight.

**Response:**

```json
{
  "subscription_id": "sub_...",
  "status": "active"
}
```

Additional CRUD: `GET /catalog/subscriptions`, `DELETE /catalog/subscriptions/:id`, `PATCH /catalog/subscriptions/:id`.

### Webhook Delivery

Webhooks are notifications, not event delivery — same posture as the registry feed.

**Header namespace.** Catalog-feed webhooks use `X-AdCP-Catalog-*` headers; the registry feed uses `X-Registry-*` (see `specs/registry-change-feed.md`). The asymmetry is intentional — the catalog feed lives on each agent's own origin and shares HTTP space with that agent's other AdCP surfaces (hence the `X-AdCP-` prefix), while the registry feed is served from the central registry origin. Subscribers handling both feeds dispatch on the header namespace to route events to the right local index.

```
POST https://storefront.example.com/hooks/catalog
X-AdCP-Catalog-Signature: sha256={hmac}
X-AdCP-Catalog-Event: product.priced
X-AdCP-Catalog-Timestamp: 2026-05-18T10:00:00Z
X-AdCP-Catalog-Delivery-Seq: 4421

{
  "event_count": 3,
  "latest_event_id": "019...",
  "event_types": ["product.priced", "product.updated"],
  "feed_url": "https://salesagent.example.com/catalog/events?cursor=019..."
}
```

**Anti-replay.** The HMAC signature MUST be computed over the canonical string `{timestamp}\n{delivery_seq}\n{body}` (newline-separated), with `{timestamp}` echoed in `X-AdCP-Catalog-Timestamp` (ISO 8601) and `{delivery_seq}` a strictly monotonic per-subscription counter echoed in `X-AdCP-Catalog-Delivery-Seq`. Receivers MUST reject signatures whose timestamp is more than 5 minutes skewed from receive time, and MUST reject deliveries whose sequence number is less than or equal to the last accepted sequence (modulo retry semantics — see Retries). Captured webhook bodies cannot be replayed at a later time or to a different subscription endpoint.

**Coalescing.** Events are batched per subscriber within a jittered window of 60–300 seconds (uniform distribution per subscriber, agent's choice). The window is jittered to prevent thundering-herd amplification: a `catalog.bulk_change` that fires to all subscribers within the same 30-second band would create a synchronized re-verify storm against the agent's `get_products` / `get_signals` endpoint. The `recommendation: "wholesale_resync"` payload field is advisory — consumers MUST stagger their resyncs and MUST honor the re-fetch coalescing rule in Security Posture.

**Retries:** 3 attempts with exponential backoff (30s, 5m, 30m). 24 hours of failures → subscription marked `suspended` and subscriber notified out-of-band. The `delivery_seq` for a retried delivery is the same as the original — receivers de-dupe on `(subscription_id, delivery_seq)`, not on signature.

---

## Security Posture

Catalog events carry priced inventory changes — the same compromise-injection risks the registry feed addresses for authorizations and identity. The three load-bearing safety properties carry across one-for-one; this section restates them in the catalog context. See `specs/registry-change-feed.md` for the canonical formulation.

**Advisory event payloads.** Feed-delivered catalog state is non-authoritative. The feed exists to tell consumers *that* something changed and to deliver the post-change payload as an optimization for cheap mirroring. Consumers that take a *binding* action on the change — finalizing a media buy at the new price, committing to a withdrawn product's cancellation policy, persisting a marketplace signal's deployment as authorized — MUST re-verify against an authoritative path before acting: a direct `get_products` / `get_signals` call against the agent (with the post-change `catalog_version` they observed in the feed), or the `adagents.json` cross-reference for marketplace-signal provenance.

**What re-verify does and does not defend.** Be honest with the threat model: re-verifying with `get_products` / `get_signals` defends against feed-transport tampering (man-in-the-middle, captured-event replay, queue corruption between event-emission and webhook delivery). It does NOT defend against a compromised agent operator — the agent re-confirms its own lie. The 3.1 binding-action defense against operator compromise lives in the existing trust anchors that gate spend: the signed `create_media_buy` response (which a buyer prices their commitment against, not a feed event), and the publisher-pinned `signing_keys` in `adagents.json` for marketplace-signal provenance. Treat catalog-feed events accordingly — useful for cheap mirror invalidation, not for any decision that commits dollars or authority. The operator-compromise gap is what `R-1` (4.0 root-of-trust / key transparency) closes.

**Re-fetch coalescing.** The re-verify rule is a per-consumer safety property, not a per-event one. A catalog-wide event (e.g., `catalog.bulk_change`, or a hot rotation that touches many entities) MUST NOT cause every subscriber to hammer the agent's `get_products` / `get_signals` endpoint. Consumers MAY coalesce re-fetches per `(agent_url, entity_type)` tuple within a short window (order of the agent's `Cache-Control` `max-age`, or ~60 seconds in its absence): multiple feed events observed during that window produce at most one authoritative fetch. Coalescing MUST NOT extend past the cache TTL the agent has declared.

**Feed-event content signing (4.0 track).** The agent operator SHOULD content-sign every feed event with a long-lived agent signing key so consumers can detect a compromise that attempts to inject bogus `product.priced` / `product.removed` / `signal.*` events. This work is tracked alongside the **R-1 root-of-trust / key-transparency** deliverables for 4.0 (the same track that gates the registry feed's content-signing in `specs/registry-change-feed.md` §Feed-event content signing). Until it lands, consumers MUST rely on the re-verify rule above as the safety property — the feed is an optimization for fast change detection, not a source of pricing or authorization truth.

---

## Capability Declaration

Agents declare feed support in `get_adcp_capabilities`:

```json
{
  "catalog_change_feed": {
    "supported": true,
    "retention_window_days": 30,
    "webhooks_supported": true,
    "event_types": [
      "product.created", "product.updated", "product.priced", "product.removed",
      "signal.created", "signal.updated", "signal.priced", "signal.removed",
      "catalog.bulk_change"
    ]
  }
}
```

Agents that don't declare this stanza are presumed to not support the feed. Consumers fall back to polling via `wholesale` mode (optionally with `if_catalog_version` probes).

---

## Consumer Pattern

1. **Bootstrap:** Call `get_products buying_mode: "wholesale"` (and/or `get_signals discovery_mode: "wholesale"`) — paginated full enumeration. Persist locally with entity IDs and the returned `catalog_version`.
2. **Steady state:** Poll `GET /catalog/events?cursor={last_event_id}` every 30–60 seconds, or wait for webhook notification and then poll. Apply events to local catalog.
3. **Recovery:** If `next_cursor` returns `RETENTION_EXPIRED` or a `catalog.bulk_change` event is observed, re-bootstrap via wholesale.

The `catalog_version` token on the bootstrap response is the durable handle the consumer uses to validate its mirror against any future `get_products` / `get_signals` call. Combined with the feed, a consumer can detect drift between feed-applied state and seller-of-record state without re-fetching the catalog payload.

---

## Relationship to Other Specs

- **`specs/registry-change-feed.md`** covers the central registry (properties, agents, publishers, authorizations). This spec covers per-agent inventory (products, signals). They compose: an `agent.profile_updated` event in the registry feed indicates a coarse change at the agent level; the agent's own catalog feed gives entity-level detail.
- **`get_signals` wholesale mode** (issue #4762) defines the wholesale enumeration mode that bootstraps consumers before they switch to the feed.
- **`catalog_version` conditional fetch** (issue #4761) is a complementary cheap-probe mechanism for agents that don't implement the full feed. Consumers MAY use `catalog_version` to validate their cursor is still current without consuming feed bandwidth.

---

## Implementation Phases

1. **Event log + feed endpoint.** Reference implementation in the AdCP signals/sales agent SDKs. `catalog_events` storage, `GET /catalog/events` endpoint, capability declaration. Solves polling-based change detection.
2. **SDK `CatalogSync` client.** Add `CatalogSync` to `@adcp/client` (TypeScript first, then Go and Python). Mirrors `RegistrySync`: bootstrap via wholesale, poll the feed, maintain in-memory product/signal index, event emitter for reactivity.
3. **Webhook subscriptions.** Subscription CRUD, delivery worker with coalescing, retry/suspension logic. Most operationally complex — ship after the feed endpoint has proven stable.
4. **Cross-feed correlation.** SDK convenience: `CatalogSync` and `RegistrySync` together expose authorization-aware views ("Which agents publish signals authorized by this data provider?" answered locally from registry feed + catalog feed without server calls).

---

## Open Questions

1. **Per-agent versus federated feed.** An alternative design is a central change-feed at the registry that proxies per-agent catalogs. *Rejected:* the registry doesn't see inside agent catalogs; agents own their inventory.
2. **Required retention.** 30 days is a recommendation. Should the spec MUST a minimum? *Recommendation: SHOULD 30 days, MUST not less than 7* (reflected in the capability schema).
3. **Event ordering across entity types.** Strict per-entity ordering is required (product price changes must be linearizable per `product_id`). Cross-entity ordering is not required — UUID v7 gives consumers a stable cursor without expensive global ordering.
4. **Signing of events.** Should events be content-signed by the agent? The registry feed spec defers this to the 4.0 root-of-trust work. Same answer here — out of scope for v3.1.
