---
title: Media Products
---

# Media Products

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and how products are discovered and structured in the system.

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](../capability-discovery/creative-formats.md).
- `delivery_type` (string, required): Either `"guaranteed"` or `"non_guaranteed"`.
- `is_fixed_price` (bool, required): `true` if the price is fixed, `false` if it is auction-based.
- `cpm` (float, optional): The fixed Cost Per Mille. **Required** if `is_fixed_price` is `true`.
- `price_guidance` (PriceGuidance, optional): Pricing guidance for auction-based products. **Required** if `is_fixed_price` is `false`.
- `min_spend` (float, optional): Minimum budget requirement in USD.
- `measurement` (Measurement, optional): Included measurement capabilities. Common for retail media products.
- `creative_policy` (CreativePolicy, optional): Creative requirements and restrictions.
- `is_custom` (bool, optional): `true` if the product was generated for a specific brief.
- `expires_at` (datetime, optional): If `is_custom`, the time the product is no longer valid.

### Pricing Models

AdCP supports two pricing models, determined by the `is_fixed_price` flag.

#### Guaranteed, Fixed-Price Products
These products represent reserved inventory with a predictable price and delivery.
- `delivery_type`: `"guaranteed"`
- `is_fixed_price`: `true`
- `cpm`: A fixed float value (e.g., `45.00`).

#### Non-Guaranteed, Variable-Price Products
These products represent inventory available in an auction. The final price is not fixed.
- `delivery_type`: `"non_guaranteed"`
- `is_fixed_price`: `false`
- `price_guidance`: A `PriceGuidance` object that helps the buyer make an informed bid.

**Example `PriceGuidance`:**
```json
{
  "floor": 10.00,
  "p25": 12.50,
  "p50": 15.00,
  "p75": 18.00,
  "p90": 22.00
}
```

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

### Standard Product
```json
{
  "product_id": "connected_tv_prime",
  "name": "Connected TV - Prime Time",
  "description": "Premium CTV inventory 8PM-11PM",
  "format_ids": ["video_standard"],
  "delivery_type": "guaranteed",
  "is_fixed_price": true,
  "cpm": 45.00
}
```

### Custom Product
```json
{
  "product_id": "custom_abc123",
  "name": "Custom - Gaming Enthusiasts",
  "description": "Custom audience package for gaming campaign",
  "format_ids": ["display_300x250"],
  "delivery_type": "non_guaranteed",
  "is_fixed_price": false,
  "price_guidance": {
    "floor": 5.00,
    "p50": 8.00,
    "p75": 12.00
  },
  "is_custom": true,
  "expires_at": "2024-02-15T00:00:00Z"
}
```

### Retail Media Product
```json
{
  "product_id": "albertsons_pet_category_offsite",
  "name": "Pet Category Shoppers - Offsite Display & Video",
  "description": "Target Albertsons shoppers who have purchased pet products in the last 90 days. Reach them across premium display and video inventory.",
  "format_ids": [
    "display_300x250",
    "display_728x90", 
    "video_15s_vast"
  ],
  "delivery_type": "guaranteed",
  "is_fixed_price": true,
  "cpm": 13.50,
  "min_spend": 10000,
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
- [Creative Formats](../capability-discovery/creative-formats.md) - Supported creative specifications
