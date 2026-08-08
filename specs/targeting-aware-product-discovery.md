# Targeting-aware product discovery

## Status

Accepted implementation design. The schemas, normative documentation,
compliance scenario, and migration guidance in this change implement this
model.

## Summary

`get_products` should let a buyer provide the targeting it intends to use when
the media buy is created. Sellers should return products, prices, and forecasts
that already account for that targeting.

The discovery request has three distinct inputs:

1. `brief` describes goals, context, semantic intent, preferences, and any
   requirements without a structured representation. Explicit hard requirements
   remain binding even when stated only in prose.
2. `filters` decide which offers may be returned based on product metadata,
   commercial fit, dates, budget, availability assumptions, and reporting
   capabilities.
3. `targeting_overlay` declares concrete delivery constraints, including both
   audience eligibility and purchased-inventory selection.

A fourth input, `required_overlay_support`, declares targeting dimensions whose
values are not known yet but which the buyer must be able to set independently
on packages later. It asks for a capability, not for products or packages to be
broken out by those dimensions.

The buyer does not need to distinguish inventory coverage from runtime
targeting. A seller may satisfy a requested targeting outcome because the
product is inherently limited to that audience or because the seller can apply
an execution-time constraint. That distinction is an execution detail returned
for transparency, not a choice the buyer must make in the request.

Products returned by `get_products` are buyable, configured offers. Their
`product_id` values are opaque and stable within the discovery/refinement
context that issued them, but not permanent identities across independent
contexts. Selecting a product at `create_media_buy` accepts the targeting
resolution disclosed with that product.

## Problem

The current model splits targeting intent across several surfaces:

- Natural-language targeting appears in `brief`.
- Geographic values, keywords, and signals can appear as `get_products`
  filters.
- Similar values appear again in `create_media_buy` targeting overlays.
- Capability filters such as `required_geo_targeting` indicate what the buyer
  may want to apply later.
- Products separately declare some product-scoped targeting capabilities.

This makes it difficult to answer basic questions:

- Does the product merely cover the requested geography, or will the seller
  actually constrain delivery to it?
- Does the forecast include the hard targeting that will be applied later?
- Will adding an overlay at `create_media_buy` dramatically reduce
  availability?
- Does a metro filter mean “find products in these metros” or “target these
  metros”?
- How does a buyer say “I do not know the metros yet, but I need to create
  independently metro-targeted packages later”?

A capability declaration answers whether a control can be executed. It does
not answer what that control does to availability. The exact targeting must
therefore participate in discovery and forecasting.

## Design principles

### Targeting expresses an outcome

The buyer declares the delivery constraint it requires. The buyer does not
need to know whether a seller satisfies it through an inherently scoped product
or a runtime ad-server control.

For example, the same request can match both:

- a New York radio product whose physical coverage is already limited to the
  New York DMA; and
- a national digital product on which the seller applies a New York DMA
  constraint.

Both products must forecast and deliver only against the requested New York
inventory.

“Targeting” in this model is not limited to audience attributes. It includes
any buyer-controlled constraint on which inventory or impressions may deliver,
including placements, properties, and collections.

### Filters select products; targeting selects delivery

Filters answer “what kind of product do I want?” Targeting answers “which
impressions are eligible?” A field should not have both meanings.

### Structure what can be structured

Buyers should use an available structured field instead of encoding the same
fact only in prose. Structured input costs fewer tokens, is processed by code
rather than inference, and preserves exact semantics. The brief remains the
right place for concepts the protocol cannot express structurally.

This authoring rule does not weaken the brief. Sellers must apply explicit hard
requirements stated there. When a seller resolves hard targeting from prose,
it should confirm the machine-readable interpretation once in
`GetProductsResponse.targeting_resolution.brief_targeting`. Requirements without a structured AdCP
representation remain visible through the natural-language response.

### Exact requests do not need an echo

If the seller can honor a structured targeting overlay exactly, the product
does not echo it. Absence of Product `targeting_resolution` means exact
acceptance of that overlay for the product, but does not confirm how prose was
interpreted.

If the seller proposes a different executable constraint, the product returns
only the modifications. It does not repeat every unchanged targeting value.
When targeting was inferred from the brief rather than supplied in an overlay,
the seller may instead include the resolved predicate once in response-level
`targeting_resolution.brief_targeting`.

### A modification is a proposal, not silent substitution

A seller must never silently broaden, narrow, drop, or replace buyer targeting.
A returned modification is visible product configuration. Selecting that
configured product constitutes acceptance of the disclosed modification.

### Product identifiers identify buyable configurations

`product_id` identifies the configured thing the buyer can purchase. Buyers
must treat it as opaque. Sellers keep it stable within the discovery/refinement
context that issued it, while buyers do not assume stability across independent
contexts.

Whenever two discovery results differ in effective targeting, disclosed
modifications, price, forecast assumptions, or future overlay support, their
buyable identifiers must distinguish those configurations. Otherwise a later
`create_media_buy` call carrying only `product_id` would be ambiguous.

## `get_products` request shape

```json
{
  "brief": "Reach outdoor enthusiasts with premium video",
  "filters": {
    "channels": ["ctv"],
    "delivery_type": "guaranteed",
    "pricing_currencies": ["USD"],
    "required_metrics": ["completed_views"]
  },
  "targeting_overlay": {
    "geo_countries": ["US"]
  },
  "required_overlay_support": {
    "geo_metros": {
      "systems": ["nielsen_dma"]
    }
  }
}
```

This means:

- Curate products relevant to the brief.
- Return only guaranteed CTV products transactable in USD that report
  completed views.
- Scope all returned forecasts and configured products to US delivery.
- Return only products that allow the buyer to apply Nielsen DMA values later
  on individual packages.

It does **not** ask the seller to return one product per DMA or to create any
packages.

## `targeting_overlay` during discovery

`get_products.targeting_overlay` uses the same targeting vocabulary as package
creation. The seller evaluates the complete overlay against each candidate
product before returning it.

For every returned product:

- the seller can honor the requested targeting exactly, or has disclosed a
  proposed modification;
- pricing reflects the effective targeting;
- availability and delivery forecasts reflect the effective targeting and
  requested flight assumptions; and
- any product-specific minimums, guarantees, or limitations are evaluated
  after targeting is applied.

This removes the current filter-to-overlay translation step. For example,
`filters.countries` no longer has to become
`targeting_overlay.geo_countries`, and `filters.keywords` no longer has to
become `targeting_overlay.keyword_targets` with stricter semantics later.

### Coverage versus targeting

Coverage and targeting remain useful seller-side concepts, but are not separate
buyer request concepts.

The seller resolves each requested dimension using one or more execution modes:

- `inherent`: the product itself already guarantees the requested outcome;
- `selectable`: the seller applies a runtime or trafficking constraint;
- a dimension-specific execution mode, such as demographic continuous bounds,
  enumerated intervals, or signals.

The mode may be exposed in product or package readback for transparency. It
does not change the delivery promise.

### Inventory selection is targeting

Placements, properties, and collections are first-class inventory objects, but
selecting among them is still targeting: the selection changes the set of
impressions eligible for the package.

The targeting overlay should therefore carry inventory-selection references
using their existing identities rather than introduce parallel package fields:

```json
{
  "targeting_overlay": {
    "placement_selection": {
      "mode": "selected",
      "placement_refs": [
        {
          "publisher_domain": "pinnacle-media.example",
          "placement_id": "feed"
        },
        {
          "publisher_domain": "pinnacle-media.example",
          "placement_id": "short_video"
        }
      ]
    },
    "property_list": {
      "agent_url": "https://governance.example",
      "list_id": "properties_123"
    },
    "collection_list": {
      "agent_url": "https://governance.example",
      "list_id": "collections_456"
    }
  }
}
```

This does not duplicate placement, property, or collection identity. The
overlay references the canonical objects, just as geographic targeting
references canonical metro and postal systems.

The distinction from creative routing remains important:

- `targeting_overlay.placement_selection` determines which placements were
  purchased and may receive delivery.
- `creative_assignments[].placement_refs` determines where a particular
  creative runs within that already-purchased set.
- Creative routing never expands or narrows purchased inventory.

The same fixed-versus-selectable rule applies across inventory dimensions:

- A product whose inventory is already limited to the requested placements,
  properties, or collections satisfies the request inherently.
- A product that permits buyer selection satisfies it selectably.
- A fixed bundle containing inventory outside the requested set cannot claim an
  exact match.
- A selected placement set exactly equal to a fixed product's complete
  `mode: included` set is an inherent match. Those refs may be echoed in
  package readback but are not independently selectable.
- Placement selection is a complete purchased set. A product containing any
  fixed `mode: included` placement cannot declare selectable placement support;
  sellers offer that inventory through `mode: default` or expose a separate
  all-targetable product configuration. This avoids an unrepresentable state in
  which unavoidable inventory sits outside the selected set.

Product declarations such as placement `mode: included`,
`property_targeting_allowed: false`, and
`collection_targeting_allowed: false` describe fixed inventory. Declarations
such as placement `mode: targetable` and the corresponding targeting-allowed
flags describe selectable inventory.

This design incorporates the lifecycle gap described in
[GitHub issue #6132](https://github.com/adcontextprotocol/adcp/issues/6132), but
places `placement_selection` inside the targeting overlay instead of creating a
separate top-level package-selection system. Properties and collections are
already represented in the overlay through list references and should follow
the same discovery, resolution, forecast, update, and readback rules.

### How this supersedes issue #6132

Issue #6132 identified the missing purchased-placement lifecycle correctly,
but its proposed wire shape predated the unified inventory-targeting model in
this design. The 3.2 contract resolves the same requirements as follows:

| #6132 proposal | 3.2 contract | Reason for the change |
| --- | --- | --- |
| Top-level `placement_selection` on package request, update, and state | `targeting_overlay.placement_selection` on those lifecycle surfaces | Placement, property, and collection selection all constrain purchased inventory. One overlay prevents a second targeting system with different discovery, forecast, update, and readback rules. |
| Dedicated `update_placements` action | Existing `update_targeting` action | Authorization follows the mutation surface. A placement-only action would make placement behave differently from property and collection targeting without adding execution precision. |
| Omit only `placement_selection` to leave it unchanged | Omit the entire `targeting_overlay` to leave targeting unchanged; when supplied, the overlay is the complete desired post-state | `update_targeting` already has full-replacement semantics. Keeping one nested field patch-like would make omission ambiguous and could retain stale inventory constraints accidentally. |
| Select targetable placements while every `included` placement remains implicitly purchased | A selectable product has a complete targetable set; a product with fixed `included` placements uses `mode: default` or a separate all-targetable configuration | A complete selected set cannot truthfully omit unavoidable inventory. The split makes the purchased set auditable and prevents a seller from widening it silently. |

This is a supersession rather than a second implementation path. Sellers MUST
NOT expose both a top-level placement selection and an overlay placement
selection as competing sources of truth.

For updates, the existing `update_targeting` action governs placement,
property, and collection changes together with other overlay dimensions. A
placement-only `update_placements` action is unnecessary unless sellers need a
more granular authorization signal. `mode: default` can remain the explicit
way to restore a seller or product placement default. Successful updates echo
the committed selection; unsupported, commercially incompatible, or partial
application is rejected rather than silently changed.

Placement update failures use the existing media-buy error taxonomy:

- `INVALID_REQUEST` for unknown, cross-publisher, duplicate, fixed-placement,
  or orphaned creative-routing references. `error.field` points at the
  offending placement or creative-assignment path.
- `ACTION_NOT_ALLOWED` when `update_targeting` is not currently available;
  `error.details.attempted_action` is `update_targeting`.
- `UNSUPPORTED_FEATURE` when the product does not support the requested
  independently selectable targeting dimension or combination.
- `REQUOTE_REQUIRED` when the desired placement set is executable but falls
  outside the package's priced envelope; `error.details.envelope_field` points
  at the package `targeting_overlay.placement_selection` path.

Every failure is atomic. The seller preserves the prior overlay and creative
assignments and MUST NOT return a successful package echo for a partially
applied selection.

## `required_overlay_support`

`required_overlay_support` is for targeting the buyer intends to provide later
but cannot fully specify during discovery.

It answers:

> Can I apply this targeting dimension independently to packages created from
> this product later?

It does not answer:

> Which values should be targeted now?

It also does not request a product, forecast, allocation, or package for every
possible value.

The request uses `TargetingOverlayRequirements`; the response uses
`TargetingOverlaySupport`. Requirements contain dimensions, booleans, and
required system arrays, but never seller maxima. Matching is a product-support
superset operation:

- where a dimension permits the boolean form, product `true` satisfies every
  protocol-valid requirement for that dimension;
- when both sides are objects, every required boolean is true in the product;
- every required array is a subset of the corresponding product array; and
- for named places, every required identifier-system and country key exists,
  and requested type/version arrays are subsets of the corresponding Product
  support arrays; and
- a missing or unknown required field does not match.

Numeric limits such as `max_values_per_package` and `max_packages` are
seller-response disclosures only. They do not appear in the buyer requirement
or participate in matching.

This applies equally to audience and inventory dimensions. For example, a buyer
may require the ability to select publisher-scoped placements, a property list,
or a collection list later without knowing the eventual references during
discovery:

```json
{
  "required_overlay_support": {
    "placement_selection": true,
    "property_list": true,
    "collection_list": true
  }
}
```

For example:

```json
{
  "targeting_overlay": {
    "geo_countries": ["US"]
  },
  "required_overlay_support": {
    "geo_metros": {
      "systems": ["nielsen_dma"]
    }
  }
}
```

The seller may return support constraints with the product:

```json
{
  "product_id": "prod_configured_abc123",
  "overlay_support": {
    "geo_metros": {
      "systems": ["nielsen_dma"],
      "max_values_per_package": 20,
      "max_packages": 50
    }
  }
}
```

Because no metro values were provided, the seller cannot promise metro-level
availability. It can promise that the dimension is selectable and disclose the
conditions under which it can be used. If the buyer wants forecasts for known
metros, it should provide those values as targeting or as a separate forecast
breakdown request.

Inclusion and exclusion operators are distinct capabilities. For example,
support for `device_platform` does not imply support for
`device_platform_exclude`. A buyer that needs to provide platform exclusions
later requests `required_overlay_support.device_platform_exclude`, and a
matching product declares `overlay_support.device_platform_exclude`. Known
exclusion values belong in `targeting_overlay` and affect discovery forecasts
like every other concrete constraint. If inclusion and exclusion overlap,
exclusion wins; a seller that cannot enforce the result rejects the request
rather than silently broadening it.

Named-place overlays are stricter: the seller rejects the same
`(country, system, place_type, value)` in `geo_places` and
`geo_places_exclude`, even across catalog versions, rather than applying
exclusion precedence.

Named-place requirements bind the identifier namespace before values are
known. They key first by `system`, then by country, so two catalogs or two
same-named places cannot collide and country/type support is never interpreted
as a Cartesian product:

```json
{
  "required_overlay_support": {
    "geo_places": {
      "systems": {
        "geonames": {
          "countries": { "NL": ["city"] },
          "system_versions": ["2026-05"]
        }
      }
    }
  }
}
```

A matching Product returns the same keyed structure under
`overlay_support.geo_places`, adds `current_version` and its complete selectable
`system_versions`, and may disclose package/value limits. This is binding
permission to provide values later, not a value-specific availability promise.
`geo_places_exclude` is requested and declared independently.

## Sparse targeting resolution

### Exact acceptance

When the requested targeting can be honored exactly, the product does not echo
it:

```json
{
  "product_id": "prod_configured_exact_123",
  "name": "US premium video",
  "forecast": {
    "forecast_range_unit": "availability",
    "points": []
  }
}
```

The absence of Product `targeting_resolution` means the effective targeting
equals the structured request targeting. When hard targeting came only from the
brief, the seller should instead confirm its interpretation once in the
response-level resolution.

### Disclosed modification

When the seller cannot honor the request exactly but can offer a useful
alternative, it returns only the changed paths:

```json
{
  "product_id": "prod_configured_age_456",
  "is_custom": true,
  "expires_at": "2026-08-05T12:00:00Z",
  "targeting_resolution": {
    "modifications": [
      {
        "path": "/demographics/age",
        "operation": "replace",
        "applied": {
          "min": 25,
          "max": 34,
          "include_unknown": false
        },
        "reason": "This product executes seller-defined age intervals."
      }
    ]
  }
}
```

The buyer already has the original request, so the response does not need to
repeat it. A buyer presents the original and applied values together when it
needs to show a human-readable diff.

### Large set-valued targeting

Resolution should support set deltas so a seller does not need to echo hundreds
of unchanged postal codes:

```json
{
  "targeting_resolution": {
    "modifications": [
      {
        "path": "/geo_postal_areas",
        "operation": "remove_values",
        "selector": { "country": "US", "system": "zip" },
        "values": ["10007", "10013"],
        "reason": "No forecastable inventory for the requested flight."
      }
    ]
  }
}
```

The modification vocabulary should be typed for targeting semantics rather
than use array-index-based JSON Patch operations. Targeting arrays generally
have set semantics, so index-based patches are brittle and create accidental
meaning from ordering.

At minimum, the resolution model needs:

- `replace` for scalar, object, or whole-dimension replacement;
- `remove_values` for removing string members from explicitly enumerated
  set-valued dimensions, including postal codes addressed by stable
  `{country, system}` selector.

Broadening proposals use `replace` with the complete proposed dimension; there
is no separate `add_values` operation. Entries apply in array order to the
original overlay. A path may be replaced at most once and cannot also receive a
set removal. The complete result validates against `targeting.json`. Broadening
must never be applied without buyer acceptance through configured-product
selection.

### Acceptance

Selecting a returned `product_id` in `create_media_buy` accepts every disclosed
targeting modification bound to that product.

The seller must retain, until product expiration:

- the original targeting request;
- the ordered and typed modifications;
- the resulting effective targeting;
- the pricing and forecast assumptions; and
- the declared future overlay support.

The seller applies the effective targeting when the product is purchased.
Package readback must describe the targeting that was actually booked. There is
no successful package state in which the booked targeting differs from the
targeting accepted by selecting the configured product.

When the buyer adds a package overlay at creation through declared
`overlay_support`, the configured product targeting remains in force. The
create-time package overlay further constrains it:

```text
effective package targeting = configured product targeting
                              INTERSECT later package overlay
```

A create-time package overlay cannot broaden or remove targeting already bound
to the configured product. Sellers reject an empty or incompatible
intersection.

After creation, `update_targeting` retains its existing full-replacement
semantics over the package's effective targeting. This permits a package to
move from one targetable metro or placement to another without rediscovery.
The replacement must remain executable by the product, and the seller may
reject or require requoting when the new targeting falls outside the original
commercial envelope.

## Consistency with demographic targeting

The existing demographic model established several important invariants:

- buyer intent is represented canonically;
- execution mechanisms are explicit;
- approximate compilation is not silently accepted; and
- a stored package does not carry `equivalent: false`.

This proposal keeps those invariants but moves buyer acceptance of an
alternative earlier, into product selection.

The demographic resolution repeats `requested` and `applied` and requires
`equivalent: true`. In the implemented generic envelope it lives at
`targeting_resolution.demographics`:

1. During discovery, an exactly supported demographic predicate produces no
   targeting-resolution echo.
2. An alternative age interval is returned as a sparse product modification.
3. Selecting that configured product accepts the alternative.
4. At booking, the accepted effective predicate is the package's exact
   targeting. The package is never stored as a knowingly non-equivalent
   execution of the accepted predicate.

The package-specific targeting-resolution schema reuses demographic execution
details such as `continuous_bounds`, `enumerated_intervals`, interval IDs,
signal references, applied bases, and applied verification methods. Future
execution dimensions can be added beside `demographics` without creating more
package-level fields. A separate product-resolution schema prevents discovery
modifications and brief interpretation from leaking into booked-package state.

The sparse discovery response and complete operational package readback serve
different purposes and do not need identical verbosity.

## Request-scoped product IDs

### Product ID semantics

A returned `product_id` identifies a buyable configured offer, not a permanent
catalog record. Buyers treat it as opaque. Sellers keep it stable throughout
the same discovery/refinement lineage so a later `refine` call can reference
products from the prior response and the buyer can purchase the selected
configuration before it expires. The lineage is carried explicitly by opaque
`product_id` and `proposal_id` values; it is not a transport session and
requires no implicit conversational state. Buyers do not infer stability across
independent discovery requests that reference none of those IDs.

Sellers must mint or derive a distinct configured `product_id` whenever the
state accepted by purchasing it differs. The ID may remain stable only when it
still identifies the same complete buyable configuration unambiguously.

When a product is request-specific, it carries `is_custom: true` and
`expires_at`, even when it accepts a structured overlay exactly and therefore
has no targeting-resolution echo:

```json
{
  "product_id": "prod_configured_abc123",
  "is_custom": true,
  "expires_at": "2026-08-05T12:00:00Z"
}
```

After expiration, the seller may reject creation and require rediscovery.

On `buying_mode: refine`, every referenced `product_id` carries its prior
configuration explicitly. Top-level `filters`, `targeting_overlay`, and
`required_overlay_support`, when present, are the complete desired replacement
state for the refined results, not deltas. When omitted, the referenced
product's bound values remain in force. A refined result keeps the same ID only
if effective targeting, disclosed resolution, price, forecast assumptions,
terms, and overlay support are unchanged; otherwise the seller returns a new
configured ID and expiry. This preserves stateless exchanges while allowing
the seller's product registry to resolve opaque configured offers.

This removes the need for a separate `targeting_resolution_id`. The configured
product ID already binds the targeting resolution, price, forecast, and
applicable terms.

The existing `is_custom` flag may continue to describe whether a seller created
the request-specific configured offer. It is the explicit marker that the
opaque product is lineage-bound and expiring; `targeting_resolution` therefore
requires `is_custom: true`. This design intentionally does not introduce a
“catalog product” identifier: AdCP already uses catalogs for promoted creative
items, and overloading that term would obscure the configured-offer model.

## What remains in filters

Filters remain useful, but their scope becomes narrower and easier to explain.
They select product attributes and commercial or operational capabilities.

Filter behavior is invariant across buying modes. For every deterministic
filter predicate, every returned product must satisfy that predicate according
to its field-level match semantics. A seller must not accept `filters` and then
return an unfiltered curated set, wholesale feed, or refinement result. On
`refine`, a supplied `filters` object is the complete replacement filter state;
when it is omitted, the referenced configured product's bound discovery
constraints remain in force.

Compliance tests this by seeding both matching and non-matching products and
asserting membership, field values, and boundary behavior. It never assumes
that a filtered response must differ from an unfiltered response, because both
can legitimately contain the same products. Brief relevance remains outside
this deterministic assertion; explicit hard brief requirements are binding but
require separate tests of the seller's structured interpretation.

Likely retained filters include:

- `channels`;
- `format_ids` and format constraints;
- `delivery_type` and exclusivity;
- fixed versus auction pricing;
- pricing currencies and budget suitability;
- flight dates used for availability checks;
- reporting metrics and vendor metrics;
- performance standards;
- Trusted Match support; and
- non-targeting protocol features.

Placement-type filters such as `video_placement_types`,
`audio_distribution_types`, `sponsored_placement_types`, and
`social_placement_surfaces` remain product filters only when they describe the
kind of product the buyer is willing to consider. They do not constrain
delivery. When the buyer requires an exact purchased placement set, it uses
`targeting_overlay.placement_selection`.

Targeting-like filters move as follows:

| Existing filter                       | Proposed destination                        |
| ------------------------------------- | ------------------------------------------- |
| `countries`                           | `targeting_overlay.geo_countries`           |
| `regions`                             | `targeting_overlay.geo_regions`             |
| `metros`                              | `targeting_overlay.geo_metros`              |
| `postal_areas`                        | `targeting_overlay.geo_postal_areas`        |
| `geo_proximity`                       | `targeting_overlay.geo_proximity`           |
| `keywords`                            | `targeting_overlay.keyword_targets`         |
| `signal_targeting`                    | `targeting_overlay.signal_targeting_groups` |
| `required_geo_targeting`              | `required_overlay_support`                  |
| Placement selection                   | `targeting_overlay.placement_selection`     |
| Future inventory-selection capability | `required_overlay_support`                  |

Soft semantic audience preferences remain in `brief`. Exact demographic
predicates belong in `targeting_overlay.demographics`.

## No arbitrary external targeting controls

AdCP targeting is a typed external contract, not a remote control plane for a
seller's ad server. A seller MUST NOT accept buyer-supplied arbitrary keys,
values, or expressions through generic fields such as `custom` or
`key_value_pairs`. A capability declaration cannot make an opaque key's
semantics, authorization, privacy behavior, or cross-seller interoperability
mechanically verifiable.

Sellers compile structured AdCP targeting, signal references, and configured
products into backend keys internally. Recurring cross-seller concepts should
be standardized as typed fields with explicit resolution semantics. Seller-
published targetable concepts use signals; inventory selection uses properties,
collections, placements, and formats. The `ext` field MUST NOT be interpreted
as generic buyer-controlled ad-server targeting.

This removes the need for a separate buyer-visible “inventory coverage” filter.
When the buyer supplies targeting, the seller may satisfy it inherently or
selectably. Products incapable of satisfying the outcome are not returned.

## Forecast semantics

Every product forecast returned for a targeting-aware discovery request is
scoped to the effective targeting:

```text
offered effective targeting = requested targeting transformed by
                              disclosed product modifications
```

The forecast must not describe the untargeted base product while the buyable
product represents a narrower audience.

If the buyer changes targeting later:

- changes explicitly permitted by `overlay_support` may be applied subject to
  the disclosed limits;
- the seller must reforecast or requote when the change materially alters the
  priced or guaranteed envelope; and
- unsupported changes are rejected rather than ignored.

`required_overlay_support` without values cannot produce a value-specific
availability guarantee. It guarantees selectability only.

## End-to-end examples

### Exact metro targeting, satisfied inherently

Request:

```json
{
  "brief": "Local audio campaign",
  "targeting_overlay": {
    "geo_metros": [{ "system": "nielsen_dma", "values": ["501"] }]
  }
}
```

A New York radio product can be returned without `targeting_resolution` because
its inherent delivery is already equal to the requested outcome. Its forecast
is the available New York inventory.

### Exact metro targeting, satisfied selectably

The same request can return a national streaming-audio product if the seller
can apply DMA targeting. The seller may expose `selectable` as execution
metadata, but the buyer receives the same delivery promise and the forecast is
still scoped to New York.

### Metro values supplied later

Discovery request:

```json
{
  "brief": "National campaign managed market by market",
  "targeting_overlay": {
    "geo_countries": ["US"]
  },
  "required_overlay_support": {
    "geo_metros": {
      "systems": ["nielsen_dma"]
    }
  }
}
```

The seller returns one configured product that supports later DMA targeting.
The buyer may create multiple packages from it:

```json
{
  "packages": [
    {
      "product_id": "prod_configured_abc123",
      "targeting_overlay": {
        "geo_metros": [{ "system": "nielsen_dma", "values": ["501"] }]
      }
    },
    {
      "product_id": "prod_configured_abc123",
      "targeting_overlay": {
        "geo_metros": [{ "system": "nielsen_dma", "values": ["803"] }]
      }
    }
  ]
}
```

The seller was not asked to return one product per market. The buyer chose to
create two packages from one product.

### Seller-supported age interval

The buyer requests ages 21–35. A product backed by enumerated intervals can
execute only ages 25–34. Instead of silently narrowing or rejecting the entire
discovery request, the seller may return a configured product with a sparse
replacement of `demographics.age`.

The buyer can reject that product, or select it and thereby accept ages 25–34.
At booking, ages 25–34 are the exact accepted and applied predicate.

## Interaction with `buying_mode`

This targeting model is independent of whether discovery is curated or a raw
catalog read. Targeting, curation, and feed synchronization are orthogonal
concerns.

The current `brief` versus `wholesale` distinction bundles several behaviors:

- whether a brief is allowed;
- whether seller curation occurs;
- whether proposals may be returned;
- whether asynchronous completion is allowed; and
- whether wholesale feed versioning applies.

That remains confusing even after targeting is fixed. A follow-on design should
consider separating:

- discovery presentation, such as `curated` versus `catalog`; and
- feed synchronization mechanics, such as conditional version reads.

This design does not require that redesign to land, but neither
`targeting_overlay` nor `required_overlay_support` should have different
meanings across buying modes.

## Migration outline

This is an additive AdCP 3.2 design. Targeting-like filters remain accepted but
deprecated, and the demographic package field is renamed before its first 3.2
release, so no released 3.1 wire shape is removed.

1. Add `targeting_overlay` and `required_overlay_support` to
   `get_products`.
2. Define sparse targeting modifications and configured-product acceptance.
3. Define product IDs as opaque buyable identities that are stable inside one
   discovery/refinement context, not across independent contexts.
4. Scope product forecasts normatively to effective targeting.
5. Deprecate targeting-like fields in `product-filters.json`.
6. Align demographic discovery and package readback with lifecycle-specific
   targeting-resolution schemas without permitting non-equivalent stored execution.
7. Add conformance scenarios for deterministic filter behavior in brief,
   wholesale, and refine modes; exact targeting; inherent and selectable
   satisfaction; sparse modification acceptance; large set deltas; product
   expiration; future overlay support; purchased inventory selection; and the
   separation between inventory selection and creative routing.

During a compatibility window, sellers may translate legacy targeting filters
into the corresponding discovery overlay. Requests that provide both a legacy
field and its overlay replacement must either be semantically identical or be
rejected with `INVALID_REQUEST` as ambiguous.

Release negotiation is the coarse compatibility gate; this design does not add
a redundant `targeting_aware_discovery` feature flag. Buyers use the 3.2 entry
in `get_adcp_capabilities.adcp.supported_versions`, pin `adcp_version` on the
request, and validate against the echoed served release. A buyer that sees only
3.1-or-earlier release precision, or only ambiguous legacy major precision,
must omit the 3.2 discovery fields and use the retained legacy fields or brief
prose. A 3.2 seller serving a 3.1 pin emits a 3.1-shaped response; if it cannot
serve 3.1, it returns `VERSION_UNSUPPORTED` rather than relabeling 3.2 output.

## Schema surface

The implemented schema surface is:

### Request

- `get-products-request.json`
  - add `targeting_overlay`
  - add `required_overlay_support` using
    `targeting-overlay-requirements.json`
- `product-filters.json`
  - deprecate targeting-like filters
- `targeting.json`
  - add `placement_selection` using publisher-scoped `PlacementRef` values
  - add typed `device_platform_exclude`; exclusion wins on overlap and sellers
    reject unenforceable exclusions rather than dropping them
- `targeting-overlay-requirements.json` and
  `targeting-overlay-support.json`
  - represent `device_platform_exclude` independently from platform inclusion

### Response

- `get-products-response.json`
  - add one request-level `targeting_resolution` for brief interpretation
- `product.json`
  - add `overlay_support` using `targeting-overlay-support.json`
  - add sparse `targeting_resolution` using
    `product-targeting-resolution.json`
  - require request-specific products to carry `is_custom: true` and
    `expires_at`
- `package.json` and `get-media-buys-response.json`
  - use `package-targeting-resolution.json` for execution-only readback
  - retain `property_list`, `property_list_exclude`, `collection_list`, and
    `collection_list_exclude` as inventory-selection targeting
- `placement-selection.json`
  - define `mode: selected` with a complete non-empty placement set
  - define `mode: default` for explicit restoration of product defaults

### Response product

- `product.json`
  - clarify context-stable, cross-context-opaque `product_id`
  - require `expires_at` for request-specific products
  - add optional sparse `targeting_resolution`
  - add optional `overlay_support`

### Package creation and readback

- `package-request.json`
  - continue allowing package-specific overlays within the configured product's
    declared support
- `package-update.json`
  - update placement selection through `targeting_overlay` under the existing
    `update_targeting` action and replacement semantics
- package response schemas
  - return exact effective targeting or an immutable reference sufficient for
    audit
  - preserve committed placement selection in create, update, and
    `get_media_buys` readback
  - never represent knowingly non-equivalent execution as successful

## Decisions recorded

1. Exact targeting belongs in `get_products`, not only in
   `create_media_buy`.
2. Filters remain, but target product characteristics rather than impression
   eligibility.
3. Buyers do not distinguish inherent coverage from applied targeting in the
   request.
4. Buyers can require future package-level targeting support without providing
   values or requesting products per value.
5. Exact acceptance does not echo structured targeting; brief-derived hard
   targeting should be confirmed once at response level.
6. Proposed differences are sparse modifications that require acceptance by
   selecting the configured product.
7. Large set-valued targeting supports semantic deltas.
8. `equivalent: false` is never a successful booked-package state.
9. `product_id` is opaque and stable within its discovery/refinement context;
   cross-context stability is not assumed.
10. Placement, property, and collection selection are targeting dimensions;
    creative placement references remain routing instructions only.
11. A hard requirement remains binding in a brief, but buyers should use a
    structured field whenever one exists to reduce tokens and inference loss.
12. Inclusion and exclusion operators declare support independently; typed
    `device_platform_exclude` is the first explicit platform exclusion.
13. External buyers never supply arbitrary ad-server keys or values. Sellers
    keep backend compilation private and expose standardized fields or signals.

## Deferred follow-ups

1. Complete package readback continues to echo effective targeting for 3.2;
   immutable snapshots or digest-only readback require a separate design.
2. Replacing `buying_mode` with orthogonal curation and feed controls is outside
   this change.
