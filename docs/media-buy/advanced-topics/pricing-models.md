---
title: Pricing Models
description: Comprehensive guide to AdCP's flexible pricing models including CPM, CPCV, CPP, CPC, and DOOH support
keywords: [pricing models, CPM, CPCV, CPP, CPC, CPV, GRP, video pricing, DOOH, share of voice, measurement]
---

# Pricing Models

AdCP supports multiple pricing models to accommodate different advertising channels and business objectives. Publishers declare which pricing models they support, and buyers select from available options.

## Publisher-Declared, Buyer-Selected Model

### How It Works

1. **Publishers declare pricing options** in their products via `pricing_options` array
2. **Buyers discover available options** through `get_products`
3. **Buyers select a pricing model** when creating a media buy via `pricing_selection`
4. **Delivery is measured** according to the selected pricing model

### Key Benefits

- **Flexibility**: Publishers can offer multiple pricing models for the same inventory
- **Currency Support**: Publishers specify supported currencies; buyers must match
- **Market Standards**: Each channel (TV, video, display, performance) can use its natural pricing unit
- **Clear Expectations**: Both parties agree on pricing before campaign launch

## Measurement & Source of Truth

### Measurement Provider as Source of Truth

**The product declares the measurement provider, and the buyer accepts that provider as the source of truth for the buy.**

Publishers specify their measurement provider in the product:

```json
{
  "product_id": "premium_video",
  "delivery_measurement": {
    "provider": "Google Ad Manager with IAS viewability verification",
    "notes": "MRC-accredited viewability measurement. 50% in-view for 1 second (display) or 2 seconds (video)."
  }
}
```

**Common Measurement Providers:**
- **Ad Servers**: Google Ad Manager, Freewheel, SpringServe
- **Attention Metrics**: Adelaide, Lumen, TVision
- **Third-Party Verification**: IAS, DoubleVerify, Scope3
- **TV/Audio Measurement**: Nielsen, Comscore, iSpot.tv, Triton Digital
- **DOOH**: Geopath, Vistar, Place Exchange

By accepting the product, buyers agree to use the declared measurement provider as the authoritative source for delivery metrics.

### Best Practices

**For Publishers:**
- Clearly identify your measurement provider (ad server and any third-party verification)
- Explain your measurement methodology in plain language
- For DOOH, specify your audience measurement source (e.g., Geopath, venue sensors)

**For Buyers:**
- Review the measurement provider before committing budget
- Ensure the provider meets your campaign requirements
- Negotiate audit rights in contracts if needed

## Supported Pricing Models

### CPM (Cost Per Mille)
**Cost per 1,000 impressions** - Traditional display advertising pricing.

**Use Cases**: Display, native, banner advertising

**Example**:
```json
{
  "pricing_model": "cpm",
  "rate": 12.50,
  "currency": "USD",
  "is_fixed": true,
  "min_spend": 5000
}
```

**Billing**: Charged per 1,000 ad impressions served

---

### CPCV (Cost Per Completed View)
**Cost per 100% video/audio completion** - Payment only for fully completed views.

**Use Cases**: Video campaigns, audio ads, pre-roll video

**Example**:
```json
{
  "pricing_model": "cpcv",
  "rate": 0.15,
  "currency": "USD",
  "is_fixed": true
}
```

**Billing**: Charged only when viewer completes 100% of the video/audio ad. Completion is measured by the declared measurement provider.

---

### CPV (Cost Per View)
**Cost per view at threshold** - Payment when viewer reaches publisher-defined threshold.

**Use Cases**: Video campaigns with shorter completion requirements

**Example**:
```json
{
  "pricing_model": "cpv",
  "rate": 0.08,
  "currency": "USD",
  "is_fixed": true,
  "parameters": {
    "view_threshold": 0.5
  }
}
```

**Billing**: Charged when viewer reaches threshold (e.g., 50% completion, 30 seconds)

**Parameters**:
- `view_threshold`: Decimal from 0.0 to 1.0 (e.g., 0.5 = 50% completion)

---

### CPP (Cost Per Point)
**Cost per Gross Rating Point** - Traditional TV/radio buying metric.

**Use Cases**: Connected TV, linear TV, radio, audio streaming

**Example**:
```json
{
  "pricing_model": "cpp",
  "rate": 250.00,
  "currency": "USD",
  "is_fixed": true,
  "parameters": {
    "demographic": "A18-49",
    "min_points": 50
  },
  "min_spend": 12500
}
```

**Billing**: Charged per rating point delivered to target demographic

**Parameters**:
- `demographic`: Target demographic (e.g., "A18-49", "W25-54", "M35+")
- `min_points`: Minimum GRP commitment required

**Metrics Reported**:
- `grps`: Total Gross Rating Points delivered
- `reach`: Unique individuals reached
- `frequency`: Average frequency per individual

**Measurement Requirements**:

CPP pricing requires **certified demographic measurement**. Publishers should declare their measurement provider:

```json
{
  "pricing_model": "cpp",
  "rate": 250.00,
  "delivery_measurement": {
    "provider": "Nielsen DAR",
    "notes": "Panel-based demographic measurement for A18-49. GRP reports available weekly."
  }
}
```

**Common Measurement Providers for CPP**:
- **Nielsen DAR/TV**: Industry-standard TV measurement
- **Comscore**: Campaign Ratings for CTV
- **iSpot.tv**: Advanced TV analytics
- **Triton Digital**: Audio/streaming measurement

Buyers should verify the measurement provider meets their campaign requirements before accepting CPP deals.

---

### CPC (Cost Per Click)
**Cost per click** - Performance-based pricing for engagement.

**Use Cases**: Direct response campaigns, search ads, social advertising

**Example**:
```json
{
  "pricing_model": "cpc",
  "rate": 1.50,
  "currency": "USD",
  "is_fixed": false,
  "price_guidance": {
    "floor": 0.50,
    "p50": 1.20,
    "p75": 2.00
  }
}
```

**Billing**: Charged only when user clicks the ad

---

### Flat Rate
**Fixed cost** - Single payment regardless of delivery volume.

**Use Cases**: Sponsorships, takeovers, exclusive placements, branded content

**Example**:
```json
{
  "pricing_model": "flat_rate",
  "rate": 50000.00,
  "currency": "USD",
  "is_fixed": true
}
```

**Billing**: Fixed cost for the entire campaign period

---

## Digital Out-of-Home (DOOH) Pricing

DOOH advertising uses existing pricing models—typically **CPM** or **flat_rate**—with optional parameters to describe the inventory allocation.

### Basic Concepts

- **CPM for DOOH**: Priced per thousand impressions, where impressions are calculated based on venue traffic (e.g., Geopath data)
- **Flat rate for DOOH**: Fixed cost for specific duration or allocation (hourly, daily, or exclusive takeover)

### Simple Example: Billboard Takeover

```json
{
  "product_id": "billboard_takeover",
  "name": "Premium Billboard - 24 Hour Takeover",
  "pricing_options": [{
    "pricing_model": "flat_rate",
    "rate": 50000.00,
    "currency": "USD",
    "is_fixed": true
  }],
  "delivery_measurement": {
    "provider": "Geopath",
    "notes": "Venue traffic data updated monthly. Estimated 2.5M impressions over 24 hours."
  }
}
```

### DOOH Parameters (Optional)

Publishers may include additional parameters to describe DOOH inventory allocation:

- `duration_hours`: Duration for time-based pricing
- `sov_percentage`: Share of voice (% of available plays)
- `daypart`: Specific time periods (e.g., "morning_commute")
- `venue_package`: Named collection of screens

**Note**: DOOH measurement and buying practices vary by market. Publishers should clearly explain their measurement methodology and inventory allocation in the product description and `delivery_measurement` field.

---

## Multi-Currency Support

Publishers can offer the same product in multiple currencies:

```json
{
  "product_id": "premium_video",
  "pricing_options": [
    {
      "pricing_model": "cpm",
      "rate": 45.00,
      "currency": "USD",
      "is_fixed": true
    },
    {
      "pricing_model": "cpm",
      "rate": 40.00,
      "currency": "EUR",
      "is_fixed": true
    },
    {
      "pricing_model": "cpm",
      "rate": 35.00,
      "currency": "GBP",
      "is_fixed": true
    }
  ]
}
```

**Buyer Responsibility**: Buyers must select a currency that the publisher supports.

## Fixed vs. Auction Pricing

### Fixed Pricing (`is_fixed: true`)
- Publisher sets a fixed rate
- Rate is guaranteed and predictable
- Common for guaranteed inventory
- Requires `rate` field

### Auction Pricing (`is_fixed: false`)
- Final price determined through auction
- Publisher provides `price_guidance` with floor and percentiles
- Common for non-guaranteed inventory
- Buyer submits `bid_price` in media buy request

**Auction Example**:
```json
{
  "pricing_model": "cpcv",
  "currency": "USD",
  "is_fixed": false,
  "price_guidance": {
    "floor": 0.08,
    "p25": 0.10,
    "p50": 0.12,
    "p75": 0.15,
    "p90": 0.18
  }
}
```

## Buyer Selection Process

Currency is set at the **media buy level**, packages specify their pricing model and budget allocation:

```json
{
  "buyer_ref": "campaign_001",
  "budget": {
    "total": 100000,
    "currency": "USD"
  },
  "start_time": "2025-01-01T00:00:00Z",
  "end_time": "2025-01-31T23:59:59Z",
  "promoted_offering": "Q1 Brand Campaign",
  "packages": [{
    "buyer_ref": "pkg_ctv",
    "products": ["premium_ctv"],
    "format_ids": ["video_15s", "video_30s"],
    "budget": 50000,
    "pacing": "even",
    "pricing_model": "cpcv",
    "bid_price": 0.16
  }]
}
```

**How it works:**
1. Media buy sets overall `budget.currency` (e.g., "USD") - applies to all packages
2. Each package selects a `pricing_model` (e.g., "cpcv")
3. Currency + pricing_model identify which pricing option from the product applies
4. Package sets its budget allocation as a number in the media buy's currency
5. Package can specify `pacing` strategy (even, frontload, etc.)
6. If auction-based, package includes `bid_price`

## Reporting Metrics by Pricing Model

Different pricing models report different primary metrics:

| Pricing Model | Primary Metric | Secondary Metrics |
|---------------|----------------|-------------------|
| CPM | impressions | clicks, ctr, spend |
| CPCV | completed_views | impressions, completion_rate, spend |
| CPV | views | impressions, quartile_data, spend |
| CPP | grps | reach, frequency, spend |
| CPC | clicks | impressions, ctr, spend |
| Flat Rate | N/A | impressions, reach, frequency |

## Example: Multi-Model CTV Product

A publisher offering Connected TV inventory with multiple pricing options:

```json
{
  "product_id": "ctv_premium_sports",
  "name": "Premium Sports CTV",
  "description": "High-engagement sports content on CTV devices",
  "format_ids": ["video_15s", "video_30s"],
  "delivery_type": "guaranteed",
  "pricing_options": [
    {
      "pricing_model": "cpm",
      "rate": 55.00,
      "currency": "USD",
      "is_fixed": true,
      "min_spend": 15000
    },
    {
      "pricing_model": "cpcv",
      "rate": 0.22,
      "currency": "USD",
      "is_fixed": true,
      "min_spend": 15000
    },
    {
      "pricing_model": "cpp",
      "rate": 300.00,
      "currency": "USD",
      "is_fixed": true,
      "parameters": {
        "demographic": "M18-49",
        "min_points": 50
      },
      "min_spend": 15000
    }
  ]
}
```

A buyer could choose CPP pricing if they're planning TV buys, CPCV if optimizing for engagement, or CPM for reach-based campaigns.

## Best Practices

### For Publishers

1. **Offer relevant pricing models** - Match pricing to your inventory type and buyer expectations
2. **Set appropriate minimums** - Use `min_spend` to ensure campaign viability
3. **Provide price guidance** - For auction pricing, give realistic floor and percentile data
4. **Consider multi-currency** - Support currencies of your target markets
5. **Document parameters** - Clearly explain thresholds, demographics, and action types

### For Buyers

1. **Select appropriate model** - Choose pricing that aligns with campaign objectives
2. **Match currency** - Ensure you select a currency the publisher supports
3. **Set realistic budgets** - Account for minimum spend requirements
4. **Align goals with pricing** - Set delivery goals that match your pricing model
5. **Monitor relevant metrics** - Focus on the metrics that matter for your pricing model

## Migration from CPM-Only

For backward compatibility, products can still use the deprecated `is_fixed_price` and `cpm` fields. However, new implementations should use `pricing_options`.

**Old Format** (deprecated):
```json
{
  "product_id": "display_standard",
  "is_fixed_price": true,
  "cpm": 12.50
}
```

**New Format**:
```json
{
  "product_id": "display_standard",
  "pricing_options": [{
    "pricing_model": "cpm",
    "rate": 12.50,
    "currency": "USD",
    "is_fixed": true
  }]
}
```

## Related Documentation

- [Media Products](../product-discovery/media-products.md) - Product model reference
- [Creating Media Buys](../task-reference/create_media_buy.md) - How to select pricing when buying
- [Delivery Reporting](../task-reference/get_media_buy_delivery.md) - Understanding metrics by pricing model
- [Glossary](../../reference/glossary.md) - Pricing and metric definitions
