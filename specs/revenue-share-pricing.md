# Revenue-Share Media Pricing

**Status**: Draft for discussion

## Summary

AdCP recognizes `affiliate` as a media channel, and implementers are beginning
to bring affiliate use cases to the protocol. Affiliate products are commonly
priced as a percentage of attributed transaction value, but AdCP media-buy
pricing currently supports only fixed monetary prices per unit or period.

This proposal adds a `revenue_share` media pricing model for a deliberately
narrow first use case: one fixed commission rate applied to the settled,
attributed value of a specified conversion event.

GitHub issue: #5754

## Motivation

The media channel taxonomy currently describes affiliate as a performance-based
buying model that includes "CPA/CPC/rev-share." CPA and CPC are represented in
the media pricing schemas; revenue share is not. An affiliate brief such as
"4% of each attributed purchase" therefore cannot be expressed faithfully.

Mapping that commercial term to CPC or CPM loses the actual billing basis.
Treating the commission as out of band lets a transaction proceed, but prevents
buyer agents from comparing the commercial terms, calculating accrued spend,
or reconciling the result through AdCP.

Existing AdCP surfaces provide much of the required lifecycle already:

- `event_type` and `event_source_id` identify the billable outcome and its source.
- Delivery reporting carries `conversions`, `conversion_value`, `spend`,
  measurement windows, adjustment notifications, and finality.
- `measurement_terms.billing_measurement` names the billing authority and the
  window at which its values become invoiceable.
- `report_usage` supports buyer- or vendor-attested billing reconciliation.

The missing pieces are the pricing model, an unambiguous commission basis, and
rules connecting the selected rate to budget and settlement.

## Goals

- Represent a single percentage commission on attributed conversion value.
- Let buyer agents calculate and verify accrued commission spend.
- Reuse AdCP's existing event-source, measurement-authority, adjustment, and
  finality contracts.
- Support either a publisher or an affiliate network as the AdCP seller.
- Keep channel and pricing independent: `revenue_share` may be used outside the
  `affiliate` channel when the same commercial model applies.

## Non-goals

The first version does not standardize:

- tiered, category-specific, SKU-specific, or new-customer commission rates;
- bonuses, bounties, minimum guarantees, or hybrid fixed-plus-percentage terms;
- currency conversion between transaction value and commission settlement;
- item-level transaction or order feeds;
- disputes or clawbacks after a billing window has been marked final; or
- affiliate tracking links, click IDs, or attribution algorithms.

Those terms remain out of band or use seller extensions until repeated
implementer demand justifies a portable rule model.

## Economic model

The model uses three distinct values:

| Value | Meaning |
|---|---|
| `conversion_value` | Total value of attributed conversions for analytics. |
| `commissionable_value` | The settled portion of attributed value to which the agreed commission rate applies. |
| `spend` | Commission owed by the buyer for the reporting window. |

The normative calculation is:

```text
spend = round_currency(commissionable_value * commission_rate)
```

`commissionable_value` is separate from `conversion_value` because a commercial
agreement may exclude taxes, shipping, discounts, returned goods, ineligible
SKUs, or other components of transaction value. The billing authority computes
`commissionable_value` under the parties' agreement. AdCP makes that value and
the arithmetic auditable; it does not attempt to encode every eligibility rule
in the first version.

`commission_rate` is a decimal proportion from greater than 0 through 1. For
example, `0.04` means 4%. This follows the financial `rate` convention already
used by media-buy cancellation policies and price-breakdown adjustments. The
seller rounds once, after multiplication, to the ISO 4217 minor-unit precision
of `currency`.

## Proposed pricing option

```json
{
  "pricing_option_id": "affiliate_purchase_4pct",
  "pricing_model": "revenue_share",
  "event_type": "purchase",
  "event_source_id": "affiliate_attribution",
  "commission_rate": 0.04,
  "currency": "USD",
  "commission_basis_description": "Net merchandise value after discounts, excluding tax and shipping; returns removed before commission lock."
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `pricing_option_id` | string | Yes | Unique identifier for this option within the product. |
| `pricing_model` | const `revenue_share` | Yes | Pricing discriminator. |
| `event_type` | EventType | Yes | Conversion event whose attributed value may become commissionable. |
| `custom_event_name` | string | Conditional | Required when `event_type` is `custom`, matching CPA behavior. |
| `event_source_id` | string | Yes | Event source whose attribution is used for billing. |
| `commission_rate` | number, `(0, 1]` | Yes | Decimal proportion applied to `commissionable_value`. |
| `currency` | ISO 4217 string | Yes | Currency of `commissionable_value` and the resulting `spend`. |
| `commission_basis_description` | string | Yes | Human-readable definition of inclusions, exclusions, and return treatment used to calculate `commissionable_value`. |

The option does not carry `fixed_price`, `floor_price`, `price_guidance`, or
`max_bid`. It is contingent pricing, not fixed-unit pricing and not an auction.

Only one `commission_rate` applies to a pricing option. A seller that needs two
simple rates can publish separate products or pricing options when each option
has an independently selectable and measurable commission basis. Rule-driven
rate tables remain out of scope.

## Seller model

The seller is the party that contracts with the buyer and invoices through
AdCP. That may be:

- a publisher selling its own affiliate placements; or
- an affiliate network aggregating publisher supply and acting as the sales
  agent for the resulting product.

The pricing model does not require one canonical affiliate topology. Existing
aggregator and delegated-network patterns determine how the seller represents
the underlying supply.

## Product discovery

A seller advertises `revenue_share` like any other pricing option:

```json
{
  "product_id": "pinnacle_affiliate_content",
  "name": "Pinnacle content commerce",
  "channels": ["affiliate"],
  "pricing_options": [
    {
      "pricing_option_id": "purchase_4pct",
      "pricing_model": "revenue_share",
      "event_type": "purchase",
      "event_source_id": "pinnacle_affiliate_attribution",
      "commission_rate": 0.04,
      "currency": "USD",
      "commission_basis_description": "Net merchandise value after discounts, excluding tax and shipping; returns removed before commission lock."
    }
  ],
  "reporting_capabilities": {
    "available_metrics": [
      "conversions",
      "conversion_value",
      "commissionable_value",
      "spend"
    ],
    "measurement_windows": [
      {
        "window_id": "commission_locked_60d",
        "description": "Attributed purchases after the 60-day return and cancellation window",
        "duration_days": 60,
        "expected_availability_days": 67,
        "is_guarantee_basis": true
      }
    ]
  }
}
```

A product offering `revenue_share` MUST declare `commissionable_value` and
`spend` in its reporting capabilities.

### Fixed-versus-auction filtering

Today `is_fixed_price` treats every pricing option without `fixed_price` as
auction-based. Applying that rule to revenue share would incorrectly require a
`bid_price` and expose the product through an auction filter.

This proposal introduces an optional discovery filter:

```json
{
  "filters": {
    "pricing_structures": ["fixed", "auction", "contingent"]
  }
}
```

`revenue_share` has the `contingent` structure. Existing pricing models retain
their current fixed-versus-auction classification. The legacy
`is_fixed_price` filter remains supported, but contingent options match neither
`true` nor `false`; callers seeking contingent pricing use
`pricing_structures`. When `is_fixed_price` is supplied, a seller MUST omit
contingent options from the filtered result.

This avoids silently classifying revenue share as auction pricing while
preserving existing behavior for current callers.

## Media-buy commitment and budget

The buyer selects the pricing option normally and does not send `bid_price`:

```json
{
  "product_id": "pinnacle_affiliate_content",
  "pricing_option_id": "purchase_4pct",
  "budget": 10000,
  "measurement_terms": {
    "billing_measurement": {
      "vendor": { "domain": "pinnacle-measurement.example" },
      "measurement_window": "commission_locked_60d",
      "finalization_deadline_hours": 168
    }
  }
}
```

For `revenue_share`, package `budget` is the maximum commission payable, not the
value of attributed sales. The seller MUST NOT invoice above the package budget
without an accepted budget update. Because conversions and returns settle after
delivery, the seller is responsible for managing attribution-tail exposure when
deciding whether to continue or pause the package.

`pacing` remains optional. It describes the seller's intended delivery pacing,
but agents must not infer that commission accrues evenly during the flight.

## Reporting and settlement

### Seller-attested reporting

Delivery reporting adds `commissionable_value` to the standard metric set. A
settled package row could be:

```json
{
  "package_id": "pkg_affiliate_001",
  "pricing_model": "revenue_share",
  "conversions": 320,
  "conversion_value": 125000,
  "commissionable_value": 112500,
  "spend": 4500,
  "currency": "USD",
  "measurement_window": "commission_locked_60d",
  "is_final": true,
  "finalized_at": "2026-10-08T18:00:00Z"
}
```

The buyer verifies `112500 * 0.04 = 4500`. `conversion_value` remains available
for analytics but is not the billing basis.

Before finalization, the seller may send `adjusted` notifications for the same
window or a `window_update` in which a later commission-lock window supersedes
an earlier provisional window. Returns and cancellations reduce
`commissionable_value`; the corresponding `spend` is recalculated from the
agreed rate.

### Buyer- or vendor-attested reporting

`report_usage` adds optional `conversions`, `conversion_value`, and
`commissionable_value` fields to each usage record. A revenue-share
reconciliation record includes `commissionable_value`:

```json
{
  "account": { "account_id": "acct_pinnacle_affiliate" },
  "media_buy_id": "mb_affiliate_2026",
  "pricing_option_id": "purchase_4pct",
  "conversions": 320,
  "conversion_value": 125000,
  "commissionable_value": 112500,
  "vendor_cost": 4500,
  "currency": "USD",
  "measurement_window": "commission_locked_60d",
  "final": true,
  "finalized_at": "2026-10-08T18:00:00Z"
}
```

For a revenue-share record, `vendor_cost` is the commission owed and MUST equal
`round_currency(commissionable_value * commission_rate)`.
`media_buy_id`, `pricing_option_id`, and `commissionable_value` are required for
this pricing model; `conversions` and `conversion_value` remain optional
analytics fields.

## Schema and documentation impact

An implementation PR following an accepted decision would update:

- `static/schemas/source/enums/pricing-model.json`
- `static/schemas/source/pricing-options/revenue-share-option.json` (new)
- `static/schemas/source/core/pricing-option.json`
- `static/schemas/source/core/delivery-metrics.json`
- `static/schemas/source/enums/available-metric.json`
- `static/schemas/source/account/report-usage-request.json`
- `static/schemas/source/core/product-filters.json`
- generated schema registries and released artifacts as required
- media pricing, product discovery, delivery reporting, billing-authority, and
  channel-taxonomy documentation

`measurement-terms.json` does not require a structural change. Its description
should be expanded to identify `commissionable_value` as the billing metric for
`revenue_share`.

## Conformance scenarios

The implementation should include an end-to-end affiliate storyboard that:

1. Discovers an affiliate product with a 4% revenue-share option.
2. Creates a package with a commission budget and no `bid_price`.
3. Receives provisional attributed value while the return window is open.
4. Receives an adjustment that reduces commissionable value after a return.
5. Receives a final locked window and verifies `spend` from the selected rate.
6. Reconciles the same result through `report_usage` when the billing authority
   is the buyer or a named measurement vendor.
7. Rejects a record whose `vendor_cost` does not match the commission formula.
8. Confirms the package cannot be invoiced above its commission budget without
   an accepted budget update.

Schema tests should also confirm that revenue-share options do not accept
`fixed_price`, `floor_price`, `price_guidance`, `max_bid`, or a buy-time
`bid_price`.

## Alternatives considered

### Extend CPA with `commission_rate`

Rejected. Fixed cost per acquisition and percentage of transaction value are
different billing units. Giving one discriminator two shapes makes discovery,
comparison, and settlement behavior less explicit.

### Use `price_breakdown.adjustments[kind=commission]`

Rejected. A price-breakdown commission allocates an already-determined media
price between parties without changing the buyer's committed price. Affiliate
revenue share determines the buyer's price from attributed transaction value.

### Keep the commission entirely out of band

Viable for integrations that do not want AdCP billing, but insufficient as the
only protocol answer. It leaves agents unable to discover or compare the actual
commercial term and preserves the current taxonomy/schema inconsistency.

### Add a generic custom media pricing model

Deferred. A custom escape hatch could carry affiliate metadata but would not
give agents a portable formula or settlement contract. It is useful only when
the terms require operator review, not as the standard representation of the
common single-rate case.

### Reuse `conversion_value` directly

Rejected. Gross attributed value and the contractually eligible commission
basis often differ. Reusing one field would either make billing ambiguous or
silently change the existing analytics metric's meaning.

## Compatibility and versioning

The wire additions are additive. Sellers that do not support revenue share omit
the option. Buyers must tolerate the new `pricing_model` enum value under the
protocol's normal additive-enum rules and must not route it through auction
handling.

The `pricing_structures` filter is additive. Defining contingent options as
outside both values of `is_fixed_price` adds behavior for a class that does not
exist today, but may expose implementations that mechanically equate the
absence of `fixed_price` with auctions. Those implementations must branch on
the pricing model or structure before requiring `bid_price`. This compatibility
point should receive explicit WG review before implementation.

Target the next protocol minor after WG acceptance. Released schema versions
remain unchanged.

## Reviewer checklist

- [ ] A single-rate model covers a real near-term affiliate integration.
- [ ] `commissionable_value` is the correct portable billing basis.
- [ ] Decimal `commission_rate` (`0.04` = 4%) is consistent with media-buy conventions.
- [ ] Requiring `event_source_id` provides enough attribution identity.
- [ ] Existing measurement windows, adjustments, and finality can represent the return-lock lifecycle.
- [ ] Package `budget` should cap commission payable as proposed.
- [ ] Contingent pricing should be excluded from both values of the legacy `is_fixed_price` filter.
- [ ] The deferred rate-rule cases are correctly scoped out of the first version.

## Open questions for implementers

1. Which value do current affiliate integrations expose as the commission base:
   gross order value, net merchandise value, or an already-computed eligible
   amount?
2. Can those integrations publish provisional and locked values through named
   measurement windows, including downward adjustments for returns?
3. Do operators need multiple simultaneously selectable rates in the first
   version, or can materially different rates be represented as separate
   products or pricing options?
4. Is a hard commission budget operationally enforceable given attribution
   lag, or does the protocol also need an explicit, buyer-approved overage rule?
