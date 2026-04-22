# Dependency Impact & Health Notifications

Status: Draft — RFC for 3.1
Tracking issue: (to be filed)

## Problem

A live media buy depends on a set of upstream resources: creatives, audiences,
signals, properties, products/packages, event sources. Any of these can change
state mid-flight in ways that degrade or disable delivery:

- Seller disapproves a previously-approved creative (policy change, takedown
  request, content drift).
- Seller suspends an audience (consent expiry, PII hash audit failure, TTL).
- Signal or event source stops firing (measurement outage, tag removal).
- Property is depublished or changes ownership (ad-infra/brand.json churn).
- Product is withdrawn from the catalog.

**Today, the buyer finds out only by polling.** There is no push channel for
"something your live campaign depends on just changed," and no per-media-buy
health surface that aggregates these impacts. The `notification_type` enum
covers delivery reporting (`scheduled | final | delayed | adjusted`) but has
no concept of a dependency event. `media-buy-status` has no "at-risk" state.
`event-source-health` is the only existing parent-dependency health pattern
and it's pull-only, evaluated at proposal time.

The result: agents running campaigns at scale have no reliable way to detect
degradation until delivery craters, and humans in the loop learn about
problems from the pacing dashboard rather than from the protocol.

## Goal

Give buyers a reliable, push-capable signal when a live media buy is
impaired by an upstream dependency change — **at the media-buy level**, not
per-resource — while keeping per-resource lifecycle truth in the resources
themselves.

## Design Principles

- **Resources own their own lifecycle state.** Audiences, creatives, signals,
  event sources, properties, and products each expose seller-initiated offline
  transitions in their own status enum. One source of truth per resource.
- **The media buy is the consumer surface.** Buyers reason about "is my
  campaign running?", not "which of my 14 creatives is disapproved?" The
  media-buy aggregates dependency health into a single health signal and a
  structured `impacts[]` array.
- **Notifications fire at the media-buy level.** One webhook per affected
  media buy, not one per dependency mutation. Reduces noise and matches what
  the buyer needs to act on.
- **Pull works without push.** Every push signal has a polling equivalent on
  the media-buy object. Buyers without webhook infrastructure don't miss
  state — they just learn later.
- **Monotonic status still holds.** Resource-level status transitions remain
  spec-governed lifecycle moves, visible to `status.monotonic` assertions.
  Adding seller-initiated offline states extends the lifecycle graph rather
  than bypassing it.
- **No silent disappearance.** A resource that goes offline MUST emit a
  status transition on its next sync/discovery response. Vanishing from
  `list_*` calls without a transition is non-compliant.

## Scope

**In scope**
- Per-resource "seller took this offline" lifecycle states across audience,
  creative, catalog-item/product, event-source, property.
- Media-buy health surface: new `at_risk` (or equivalent) state on
  `media-buy-status` and an `impacts[]` structured field describing which
  dependencies are degraded and why.
- Push-notification channel for dependency-impact events: a new
  `notification_type` value routed through existing
  `push_notification_config`.
- Compliance assertions: `status.monotonic` coverage extended to resources
  gaining offline states; a new `impact.coherence` assertion to validate
  that per-resource transitions and media-buy `impacts[]` stay in sync.

**Out of scope (separate tracks)**
- Buyer-initiated lifecycle changes (buyer archiving their own creative,
  buyer pausing their own media buy). Already modeled.
- Delivery-performance alerts ("CPM drifted," "pacing behind"). Covered by
  `delayed` / `adjusted` notifications.
- Measurement quality drift that doesn't reflect event-source *availability*
  (e.g., attribution window tuning). Event-source *presence* is in scope;
  event-source *quality* is the existing readiness track.
- New resource types. This RFC applies the pattern to existing dependencies.

## Design

### 1. Resource-level offline states

Each dependency resource adds seller-initiated offline transitions to its
lifecycle enum. These are ratcheted into the existing `status.monotonic`
graph.

- `audience-status`: add `suspended`. (Closes #2838.) Sellers MUST emit
  `suspended` when an audience is no longer usable for targeting
  (consent expiry, PII audit failure, TTL, policy enforcement) and MUST
  include a structured reason in the sync response.
- `creative-status`: already has `rejected` and `archived`. Clarify that
  `rejected` is a valid transition *from* `approved` (not only from
  `pending_review`) when a seller revokes approval post-approval. Document
  the transition in `creative-status.json` enumDescriptions.
- `catalog-item-status`: verify `withdrawn` / equivalent covers seller
  removal. Gap-fill if missing.
- `event-source-health.status`: confirm `insufficient` adequately models
  "stopped firing" or add a dedicated `offline` state.
- Property (via `brand.json` / catalog): document how depublication
  surfaces. May require a new status field rather than an enum extension.

### 2. Media-buy health surface

Add to `media-buy-status` enum: **`at_risk`** (or `impaired` — naming open).
Transitions:
- `active → at_risk` when one or more dependencies enter an offline state
  *and* affect delivery for that buy.
- `at_risk → active` when impacts clear (buyer remediates, seller restores).
- `at_risk → paused` or `at_risk → canceled` as normal downstream moves.

Add to the media-buy object an **`impacts[]`** array, present when
`status = at_risk`:

```json
{
  "impacts": [
    {
      "resource_type": "audience",
      "resource_id": "aud_123",
      "package_ids": ["pkg_a", "pkg_b"],
      "transition": { "from": "ready", "to": "suspended" },
      "reason_code": "consent_expired",
      "reason": "Hashed identifier consent basis expired on 2026-06-01.",
      "observed_at": "2026-06-02T14:11:00Z",
      "remediation": "Re-sync audience after refreshing consent upstream."
    }
  ]
}
```

`reason_code` draws from a new enum (to be designed) covering at least:
`policy_violation`, `consent_expired`, `ttl_expired`, `pii_audit_failed`,
`seller_removed`, `content_rejected`, `source_offline`, `property_depublished`.

### 3. Push notifications

Add to `notification-type` enum: **`impact`** (naming open — alternatives:
`dependency_changed`, `health_changed`).

Webhook payload mirrors the `impacts[]` entry plus media-buy context:

```json
{
  "notification_type": "impact",
  "media_buy_id": "mb_456",
  "status": "at_risk",
  "impacts": [ /* same shape as above */ ],
  "notification_id": "ntf_...",
  "occurred_at": "2026-06-02T14:11:03Z"
}
```

Debouncing: sellers SHOULD coalesce multiple near-simultaneous dependency
transitions on the same media buy into a single notification with multiple
`impacts[]` entries. Target coalesce window: implementation-defined, but
the spec sets a SHOULD-NOT-exceed ceiling (e.g., 5 minutes).

### 4. Compliance & assertions

- Extend `status.monotonic` coverage to resources gaining offline states.
- New assertion **`impact.coherence`**: for any media buy in `at_risk`,
  every entry in `impacts[]` MUST reference a resource whose current
  status is an offline state. Inverse: any resource in an offline state
  that is referenced by an active media buy MUST appear in that buy's
  `impacts[]`. Catches sellers who transition resources without
  propagating to the media-buy.
- Storyboard coverage: add a dependency-impact storyboard under the
  relevant specialisms (audience-sync, creative, measurement) that
  exercises the offline → at_risk → restored path end-to-end.

## Open Questions

1. **Naming.** `at_risk` vs `impaired` vs `degraded`. `impact` vs
   `dependency_changed` vs `health_changed`. Preference for short, neutral,
   and not overloaded with existing operational vocabulary.
2. **Property depublication surface.** Does this RFC own the property
   status field, or does that belong to the property-registry track
   (specs/property-registry-catalog.md)? Cross-link.
3. **Reason code enum ownership.** New top-level enum vs per-resource-type
   reason codes vs `error-code.json` extension. Leaning new enum so the
   set is the same across resource types.
4. **Coalescing window.** Fixed spec value vs seller-declared in capabilities.
5. **Backward compatibility in 3.1.** Adding enum values is additive. Adding
   `impacts[]` is additive. Adding a `notification_type` value is additive.
   All safe in a minor. The one risk: buyers who implemented exhaustive
   switches on `media-buy-status` and treat unknown values as errors. Call
   out the unknown-enum-value handling expectation.
6. **Per-dependency override.** Should buyers be able to request
   per-dependency webhooks (e.g., "notify me only on audience impacts,
   coalescence disabled") for dashboard/ops use cases, or is media-buy-level
   the only surface? Leaning media-buy-level only for v1.

## Constituent Issues

- **#2838** — audience-status: seller-initiated archival/suspension. Becomes
  the first child ticket (resource-level offline state for audiences).
- (To be filed) — media-buy `at_risk` state + `impacts[]` field.
- (To be filed) — `notification_type: impact` webhook channel.
- (To be filed) — creative-status clarification: `approved → rejected`
  transition.
- (To be filed) — catalog-item and event-source offline-state audit.
- (To be filed) — `impact.coherence` compliance assertion.
- (To be filed) — dependency-impact storyboard.

## Release Strategy

Target 3.1.0. All changes are additive enum values or additive fields — safe
in a minor release. Ship in this order to keep each PR scoped:

1. Per-resource offline states (start with audience `suspended` via #2838).
2. Media-buy `at_risk` + `impacts[]` scaffolding.
3. `notification_type: impact` webhook channel.
4. Compliance assertion + storyboard.
5. Documentation pass: unified narrative in a new "Campaign Health" doc
   under `docs/media-buy/`.

If any piece slips, it can land in 3.2 without blocking the rest —
`at_risk` without push notifications still gives buyers a polling surface;
resource-level offline states without `at_risk` still fix the per-resource
gap #2838 describes.
