---
title: Media Products
---

# Media Products

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and how products are discovered and structured in the system.

:::tip **Pricing Models**
Products declare which pricing models they support. Buyers select a specific pricing option when creating media buys. See the complete [Pricing Models Guide](../advanced-topics/pricing-models) for details on CPM, CPCV, CPP, CPC, vCPM, and flat rate pricing.
:::

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](../../creative/formats.md).
- `delivery_type` (string, required): Either `"guaranteed"` or `"non_guaranteed"`.
- `pricing_options` (list[PricingOption], required): Array of available pricing models for this product. See [Pricing Models](#pricing-models).
- `measurement` (Measurement, optional): Included measurement capabilities. Common for retail media products.
- `creative_policy` (CreativePolicy, optional): Creative requirements and restrictions.
- `is_custom` (bool, optional): `true` if the product was generated for a specific brief.
- `expires_at` (datetime, optional): If `is_custom`, the time the product is no longer valid.

### Pricing Models

Publishers declare which pricing models they support for each product. Buyers select from the available options when creating a media buy. This approach supports:

- **Multiple pricing models per product** - Publishers can offer the same inventory via different pricing structures
- **Multi-currency support** - Publishers declare supported currencies; buyers must use a supported currency
- **Flexible pricing** - Support for CPM, CPCV, CPP (GRP-based), CPA, and more

#### Supported Pricing Models

- **CPM** (Cost Per Mille) - Cost per 1,000 impressions (traditional display)
- **CPC** (Cost Per Click) - Cost per click on the ad
- **CPCV** (Cost Per Completed View) - Cost per 100% video/audio completion
- **CPV** (Cost Per View) - Cost per view at publisher-defined threshold
- **CPA** (Cost Per Action) - Cost per conversion/acquisition
- **CPL** (Cost Per Lead) - Cost per lead generated
- **CPP** (Cost Per Point) - Cost per Gross Rating Point (TV/audio)
- **Flat Rate** - Fixed cost regardless of delivery volume

#### PricingOption Structure

Each pricing option includes:
```json
{
  "pricing_option_id": "cpcv_usd_guaranteed",
  "pricing_model": "cpcv",
  "rate": 0.15,
  "currency": "USD",
  "is_fixed": true,
  "parameters": {
    "view_threshold": 1.0
  },
  "min_spend_per_package": 5000
}
```

For auction-based pricing (`is_fixed: false`), include `price_guidance`:
```json
{
  "pricing_option_id": "cpm_usd_auction",
  "pricing_model": "cpm",
  "currency": "USD",
  "is_fixed": false,
  "price_guidance": {
    "floor": 10.00,
    "p25": 12.50,
    "p50": 15.00,
    "p75": 18.00,
    "p90": 22.00
  }
}
```

#### Delivery Measurement (Required)

All products MUST declare their measurement provider:
```json
{
  "delivery_measurement": {
    "provider": "Google Ad Manager with IAS viewability verification",
    "notes": "MRC-accredited viewability. 50% in-view for 1s display / 2s video."
  }
}
```

Common provider examples:
- `"Google Ad Manager with IAS viewability"`
- `"Nielsen DAR for P18-49 demographic measurement"`
- `"Geopath DOOH traffic counts updated monthly"`
- `"Comscore vCE for video completion tracking"`
- `"Self-reported impressions from proprietary ad server"`

### Measurement Object

For products that include measurement (common in retail media):
```json
{
  "type": "incremental_sales_lift",
  "attribution": "deterministic_purchase",
  "window": "30_days",
  "reporting": "weekly_dashboard"
}
```

### CreativePolicy Object

Defines creative requirements and restrictions:
```json
{
  "co_branding": "required",  // "required", "optional", or "none"
  "landing_page": "retailer_site_only",  // "any", "retailer_site_only", "must_include_retailer"
  "templates_available": true
}
```

### Custom & Principal-Specific Products

A server can offer a general catalog, but it can also return:
- **Principal-Specific Products**: Products reserved for or negotiated with specific clients
- **Custom Products**: Dynamically generated products with `is_custom: true` and an `expires_at` timestamp

## Product Examples

### Standard CTV Product (Multiple Pricing Options)
```json
{
  "product_id": "connected_tv_prime",
  "name": "Connected TV - Prime Time",
  "description": "Premium CTV inventory 8PM-11PM",
  "format_ids": [
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "video_15s"
    },
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "video_30s"
    }
  ],
  "delivery_type": "guaranteed",
  "pricing_options": [
    {
      "pricing_option_id": "cpm_usd_guaranteed",
      "pricing_model": "cpm",
      "rate": 45.00,
      "currency": "USD",
      "is_fixed": true,
      "min_spend_per_package": 10000
    },
    {
      "pricing_option_id": "cpcv_usd_guaranteed",
      "pricing_model": "cpcv",
      "rate": 0.18,
      "currency": "USD",
      "is_fixed": true,
      "min_spend_per_package": 10000
    },
    {
      "pricing_option_id": "cpp_usd_p18-49",
      "pricing_model": "cpp",
      "rate": 250.00,
      "currency": "USD",
      "is_fixed": true,
      "parameters": {
        "demographic": "P18-49",
        "min_points": 50
      },
      "min_spend_per_package": 12500
    }
  ],
  "delivery_measurement": {
    "provider": "Nielsen DAR for P18-49 demographic measurement",
    "notes": "Panel-based measurement for GRP delivery. Impressions measured via Comscore vCE."
  }
}
```

### Auction-Based Display Product
```json
{
  "product_id": "custom_abc123",
  "name": "Custom - Gaming Enthusiasts",
  "description": "Custom audience package for gaming campaign",
  "format_ids": [
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "display_300x250"
    },
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "display_728x90"
    }
  ],
  "delivery_type": "non_guaranteed",
  "pricing_options": [
    {
      "pricing_option_id": "cpm_usd_auction",
      "pricing_model": "cpm",
      "currency": "USD",
      "is_fixed": false,
      "price_guidance": {
        "floor": 5.00,
        "p50": 8.00,
        "p75": 12.00
      }
    },
    {
      "pricing_option_id": "cpc_usd_auction",
      "pricing_model": "cpc",
      "currency": "USD",
      "is_fixed": false,
      "price_guidance": {
        "floor": 0.50,
        "p50": 1.20,
        "p75": 2.00
      }
    }
  ],
  "delivery_measurement": {
    "provider": "Google Ad Manager with IAS viewability",
    "notes": "MRC-accredited viewability. 50% in-view for 1s display."
  },
  "is_custom": true,
  "expires_at": "2025-02-15T00:00:00Z"
}
```

### Retail Media Product with Measurement
```json
{
  "product_id": "albertsons_pet_category_offsite",
  "name": "Pet Category Shoppers - Offsite Display & Video",
  "description": "Target Albertsons shoppers who have purchased pet products in the last 90 days. Reach them across premium display and video inventory.",
  "format_ids": [
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "display_300x250"
    },
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "display_728x90"
    },
    {
      "agent_url": "https://creatives.adcontextprotocol.org",
      "id": "video_15s"
    }
  ],
  "delivery_type": "guaranteed",
  "pricing_options": [
    {
      "pricing_option_id": "cpm_usd_guaranteed",
      "pricing_model": "cpm",
      "rate": 13.50,
      "currency": "USD",
      "is_fixed": true,
      "min_spend_per_package": 10000
    }
  ],
  "delivery_measurement": {
    "provider": "Self-reported impressions from proprietary ad server",
    "notes": "Impressions counted per IAB guidelines. Viewability measured via IAS."
  },
  "measurement": {
    "type": "incremental_sales_lift",
    "attribution": "deterministic_purchase",
    "window": "30_days",
    "reporting": "weekly_dashboard"
  },
  "creative_policy": {
    "co_branding": "optional",
    "landing_page": "must_include_retailer",
    "templates_available": true
  }
}
```

## Integration with Discovery

Products are discovered through the [Product Discovery](./index.md) process, which uses natural language to match campaign briefs with available inventory. Once products are identified, they can be purchased via `create_media_buy`.

## See Also

- [Product Discovery](./index.md) - How to discover products using natural language
- [Media Buys](../media-buys/index.md) - How to purchase products
- [Targeting](../advanced-topics/targeting.md) - Detailed targeting options
- [Creative Formats](../../creative/formats.md) - Understanding format specifications and discovery
