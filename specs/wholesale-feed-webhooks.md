# Wholesale Product and Signals Feed Webhooks

## Problem

Sales agents and signals agents publish wholesale product feeds (`get_products buying_mode: "wholesale"`) and wholesale signals feeds (`get_signals discovery_mode: "wholesale"`) that consumers want to mirror locally. Wholesale enumeration plus `wholesale_feed_version` lets consumers poll cheaply, but polling still has two gaps:

**Terminology note.** This spec deliberately uses **wholesale feed** for seller-side products and signals exposed by `get_products` / `get_signals`. That is distinct from `sync_catalogs`, which pushes buyer-provided campaign inputs such as product feeds, stores, and hotel feeds into a seller account.

1. **Latency.** A seller that changes pricing or removes a product cannot tell mirrors immediately unless the mirror polls.
2. **Unnecessary full reads.** A consumer that receives only a generic "something changed" notice still has to call `get_products` / `get_signals` to learn what changed.
3. **No native push payload.** Buyers need a standard webhook body that carries the changed product or signal, with enough versioning metadata to repair through the authoritative read tasks when needed.

This spec defines account-level wholesale feed webhooks. Webhooks carry the actual change payload. `get_products` and `get_signals` remain the authoritative repair and reconciliation paths.

## Goals

1. Consumers can register account-level webhooks and receive the changed product, signal, or bulk-change summary directly.
2. Consumers can update local wholesale product-feed and signals-feed mirrors without immediately re-reading the full feed after every change.
3. Consumers can detect uncertainty and repair by calling `get_products` / `get_signals` with `if_wholesale_feed_version`.
4. The mechanism is symmetric for sales agents and signals agents.
5. No new AdCP task is introduced for event polling.

## Non-Goals

- No REST endpoint.
- No event-polling task.
- No durable cursor API or retention-window error. Missed pushes are repaired through `get_products` / `get_signals`.

## Event Types

Wholesale feed webhooks use the shared `notification-type.json` enum and register through `sync_accounts.accounts[].notification_configs[]`.

| Event | Trigger | Webhook payload |
|-------|---------|-----------------|
| `product.created` | New product added to the wholesale product feed | Full post-change `Product` object |
| `product.updated` | Product metadata changed | Full post-change `Product` object, plus advisory `changed_fields[]` |
| `product.priced` | Pricing options changed | Full post-change `pricing_options[]`, retired `previous_pricing_option_ids[]`, optional `effective_at` |
| `product.removed` | Product no longer available | Product id, `removal_reason`, and affected cache layer |
| `signal.created` | New signal added to the wholesale signals feed | Full post-change signal object |
| `signal.updated` | Signal metadata changed | Full post-change signal object, plus advisory `changed_fields[]` |
| `signal.priced` | Signal pricing options changed | Full post-change `pricing_options[]`, retired `previous_pricing_option_ids[]`, optional `effective_at` |
| `signal.removed` | Signal no longer available | Signal id, `removal_reason`, and affected cache layer |
| `wholesale_feed.bulk_change` | Bulk operation too large/noisy for per-entity pushes against one feed | Summary, affected feed type, and repair recommendation |

`wholesale_feed.bulk_change` is the fast-forward event. Sellers SHOULD emit it when one operation affects **>5% of a wholesale feed** or **>100 entities**, whichever is smaller. A single bulk-change webhook describes either the wholesale product feed or the wholesale signals feed, not both, so the envelope's `wholesale_feed_version` is unambiguous. If one operation changes both feeds, the seller MUST emit one webhook per feed. Receivers SHOULD repair by re-reading the affected wholesale feed via `get_products` or `get_signals`.

## Webhook Payload

The canonical payload schema is [`core/wholesale-feed-webhook.json`](https://adcontextprotocol.org/schemas/v3/core/wholesale-feed-webhook.json). The payload wraps one [`core/wholesale-feed-event.json`](https://adcontextprotocol.org/schemas/v3/core/wholesale-feed-event.json) object.

Example `product.priced` fire:

```json
{
  "idempotency_key": "whk_01HX2N4S8J4TK8M6D3K9Q2P1A7",
  "notification_id": "019539a0-0000-7000-8000-000000000001",
  "notification_type": "product.priced",
  "fired_at": "2026-05-18T10:00:02Z",
  "subscriber_id": "wholesale-feed-sync",
  "account_id": "acc_acme_pinnacle",
  "wholesale_feed_version": "v2026-05-18T10:00:00Z-acme-rev413",
  "previous_wholesale_feed_version": "v2026-05-18T08:00:00Z-acme-rev412",
  "cache_scope": "public",
  "event": {
    "event_id": "019539a0-0000-7000-8000-000000000001",
    "event_type": "product.priced",
    "entity_type": "product",
    "entity_id": "prod_premium_ctv_us",
    "created_at": "2026-05-18T10:00:00Z",
    "payload": {
      "product_id": "prod_premium_ctv_us",
      "pricing_options": [
        { "pricing_option_id": "po_cpm_v2", "pricing_model": "cpm", "fixed_price": 18.50, "currency": "USD" }
      ],
      "previous_pricing_option_ids": ["po_cpm_v1"],
      "applies_to": { "scope": "public" }
    }
  }
}
```

### Payload Rules

- `notification_id` MUST equal `event.event_id`.
- `notification_type` MUST equal `event.event_type`.
- `idempotency_key` dedupes transport retries. `notification_id` identifies the logical feed change.
- `account_id` is REQUIRED on every wholesale feed webhook because registration is account-anchored.
- `wholesale_feed_version` is the post-change opaque version token for the affected feed and cache layer.
- `previous_wholesale_feed_version` is optional. When present, receivers MAY use it to detect obvious gaps.
- `cache_scope` mirrors the `cache_scope` returned by `get_products` / `get_signals` and MUST equal `event.payload.applies_to.scope`.
- Payloads are denormalized: sellers SHOULD include the post-change object or changed sub-object needed to update a local mirror.

### `effective_at` and Pre-Announce

`*.priced` events MAY include `effective_at`. When `effective_at` is absent or in the past, the pricing payload is the current active pricing for the affected wholesale feed layer. When `effective_at` is in the future, the event is a pre-announcement: receivers MAY store the pricing payload as pending state and warm caches, but MUST NOT use it for spend-binding decisions until the effective time has passed.

At or after the effective time, receivers MAY promote the pending pricing payload into the mirror if no retraction was received. Before any action that commits spend or authority, receivers still MUST repair through `get_products` / `get_signals`; the webhook payload is a cache update, not binding authority.

A `*.priced` event with `retracts_event_id` cancels a prior future-dated `*.priced` event. The retraction MUST name the original `event_id`, apply to the same entity and cache layer, and carry `effective_at` less than or equal to the retracted event's `effective_at`. Its `pricing_options[]` are the pricing options that remain active after the retraction. Receivers that cannot find the referenced pending event, or that receive a retraction after the referenced effective time has passed, SHOULD treat local state as uncertain and repair through the appropriate wholesale read.

## Registration

Buyers register wholesale feed webhooks through `sync_accounts.accounts[].notification_configs[]`. There is no separate subscription task.

```json
{
  "accounts": [
    {
      "account": { "account_id": "acc_acme_pinnacle" },
      "notification_configs": [
        {
          "subscriber_id": "wholesale-feed-sync",
          "url": "https://storefront.example.com/hooks/wholesale-feed",
          "event_types": [
            "product.created",
            "product.updated",
            "product.priced",
            "product.removed",
            "signal.created",
            "signal.updated",
            "signal.priced",
            "signal.removed",
            "wholesale_feed.bulk_change"
          ],
          "active": true
        }
      ]
    }
  ]
}
```

The buyer verifies applied state via `list_accounts.accounts[].notification_configs[]`. `sync_accounts` uses declarative replace semantics for this array: omit to leave existing subscribers unchanged; send `[]` to remove all subscribers; send a full array to replace.

Sellers MUST complete an endpoint activation challenge or equivalent proof-of-control before treating a wholesale feed subscriber as active. This prevents an authenticated buyer from registering an arbitrary third-party HTTPS URL as a high-volume webhook receiver. Delivery-time SSRF validation and connection pinning still apply to every webhook fire.

## Delivery Semantics

Wholesale feed webhooks follow the persistent webhook contract:

- **At least once.** Receivers dedupe retries by `idempotency_key`.
- **Event correlation.** Receivers correlate logical feed changes by `notification_id`.
- **No global ordering guarantee.** Sellers SHOULD emit sortable event ids, but receivers MUST tolerate out-of-order arrival.
- **Payload is usable but not binding authority.** Receivers MAY apply payloads to mirrors. Before any action that commits spend or authority, receivers MUST re-read through `get_products` / `get_signals`.
- **Repair path.** If a receiver observes a gap, stale version, failed signature, unexpected `previous_wholesale_feed_version`, or `wholesale_feed.bulk_change`, it repairs by calling `get_products` / `get_signals` with the last trusted `if_wholesale_feed_version` or by cold-bootstrapping the feed.
- **Per-principal scope filter.** Sellers MUST apply the same account/caller authorization predicate used by the corresponding wholesale read at webhook emission time. A caller that could not see a product, signal, price, or account overlay through `get_products buying_mode: "wholesale"` or `get_signals discovery_mode: "wholesale"` MUST NOT receive a webhook revealing that change. Agents unable to guarantee this per-principal filtering MUST NOT declare `wholesale_feed_webhooks.supported: true`.

### Headers

Wholesale feed webhooks use the same signing posture as other AdCP webhooks. The default is the AdCP RFC 9421 webhook profile. Legacy HMAC-SHA256 is allowed only when configured through `notification_configs[].authentication`.

Implementations that need a simple dispatch header MAY use `X-AdCP-Notification-Type`, but receivers MUST route correctly from the JSON payload's `notification_type`.

## Cache Layering and Event Scoping

Sellers publish two notional layers: a **public layer** (rate-card / structural / unauthenticated view) and **per-account overlays** (custom deals, account-specific rate cards). Conditional fetch and webhooks are both layer-aware.

**Versions are scope-keyed.** A `wholesale_feed_version` token describes a state for one `cache_scope` value (`"public"` or `"account"`). Consumers cache `(scope, version)` pairs and present the matching token on the next `get_products` / `get_signals` request.

**Events carry `applies_to.scope`.**

| `applies_to.scope` | Meaning | Consumer action |
|---|---|---|
| `"public"` | Affects the seller's public wholesale feed layer. | Update/invalidate the public-layer cache; account overlays referencing that public version may also be stale. |
| `"account"` with `account_ids[]` | Affects named account overlays. | Update/invalidate only those account overlays. |
| `"account"` without `account_ids` | Affects specific accounts; seller withholds the list. | Receiving the webhook means this subscriber's account scope is affected because the seller filtered delivery to authorized subscribers. Update/invalidate the receiving account overlay. |

**Cross-scope downgrade.** A seller MAY return `cache_scope: "public"` on an `if_wholesale_feed_version` request that previously had `cache_scope: "account"`. This signals "this account no longer has overrides; drop the overlay and reference the public layer." The webhook equivalent is a `*.priced` event with `applies_to: { "scope": "public" }` after a prior account-scoped event.

## Capability Declaration

Agents declare support in `get_adcp_capabilities`:

```json
{
  "wholesale_feed_webhooks": {
    "supported": true,
    "event_types": [
      "product.created", "product.updated", "product.priced", "product.removed",
      "signal.created", "signal.updated", "signal.priced", "signal.removed",
      "wholesale_feed.bulk_change"
    ]
  }
}
```

Agents that do not declare this stanza are presumed not to push wholesale feed changes. Consumers fall back to polling with `get_products` / `get_signals`, optionally using `if_wholesale_feed_version`.

Capability consistency is part of the declaration. Agents listing any `product.*` value in `wholesale_feed_webhooks.event_types[]` MUST declare and support wholesale `get_products` (`media_buy.buying_modes` includes `"wholesale"`). Agents listing any `signal.*` value MUST declare and support wholesale `get_signals` (`signals.discovery_modes` includes `"wholesale"`). Agents listing `wholesale_feed.bulk_change` MUST have at least one of those wholesale repair paths, and each bulk-change payload's `affected_entity_type` MUST name only a feed family the agent can repair through a declared wholesale read.

## Consumer Pattern

1. **Bootstrap:** Call `get_products buying_mode: "wholesale"` and/or `get_signals discovery_mode: "wholesale"`. Store entity IDs, payloads, `wholesale_feed_version`, and `cache_scope`.
2. **Subscribe:** Register `sync_accounts.accounts[].notification_configs[]` entries for the relevant event types.
3. **Apply pushes:** On each valid webhook, dedupe by `idempotency_key`, correlate by `notification_id`, and apply `event.payload` to the local mirror.
4. **Repair:** On `wholesale_feed.bulk_change`, suspicious ordering, missed delivery, or before binding spend/authority, call `get_products` / `get_signals` with `if_wholesale_feed_version`.

## Relationship to Other Specs

- **`get_products` wholesale mode** defines the wholesale product feed that bootstraps and repairs product mirrors.
- **`get_signals` wholesale mode** defines the wholesale signals feed that bootstraps and repairs signal mirrors.
- **`wholesale_feed_version` conditional fetch** is the repair probe used after missed or distrusted webhooks.
- **`sync_accounts.accounts[].notification_configs[]`** is the account-level registration surface.
- **`sync_catalogs`** is separate: buyer-provided campaign input feeds, not seller-side wholesale product/signals feeds.

## Open Questions

1. **Content signing.** The default webhook signing profile authenticates delivery. Event content signing against long-lived agent keys remains a 4.0 root-of-trust/key-transparency topic.
