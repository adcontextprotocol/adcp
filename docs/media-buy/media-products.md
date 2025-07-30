---
title: Media Products & Discovery
---

# Media Products & Discovery

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and how products are discovered through the protocol.

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](creative-formats.md).
- `delivery_type` (string, required): Either `"guaranteed"` or `"non_guaranteed"`.
- `is_fixed_price` (bool, required): `true` if the price is fixed, `false` if it is auction-based.
- `cpm` (float, optional): The fixed Cost Per Mille. **Required** if `is_fixed_price` is `true`.
- `price_guidance` (PriceGuidance, optional): Pricing guidance for auction-based products. **Required** if `is_fixed_price` is `false`.
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

### Custom & Principal-Specific Products

A server can offer a general catalog, but it can also return:
- **Principal-Specific Products**: Servers can return products reserved for or negotiated with the authenticated principal.
- **Custom Products**: The server can generate new, temporary products in response to a `brief`, returning them with `is_custom: true` and an `expires_at` timestamp. This allows for maximum flexibility without cluttering the main catalog.

## Product Discovery

Servers determine how to match products to requests based on:
- The authenticated principal's identity and permissions
- Optional brief describing campaign objectives
- Optional filters for product attributes

## Product Discovery Lifecycle

The product discovery process is designed to be intuitive and AI-friendly, allowing buyers to find relevant inventory using natural language:

### 1. Natural Language Discovery (`discover_products`)

The discovery process starts with a natural language brief that describes the campaign objectives:

```json
{
  "campaign_brief": "I want to reach pet owners in California with video ads during prime time"
}
```

The system uses AI to interpret this brief and match it against available inventory, returning relevant products with:
- **Match scores**: How well each product aligns with the brief
- **Match reasons**: Why each product was recommended
- **Product details**: Pricing, targeting capabilities, and formats

### 2. Discovery Response

The system returns products ranked by relevance:

```json
{
  "recommended_products": [
    {
      "product_id": "connected_tv_prime",
      "name": "Connected TV - Prime Time",
      "description": "Premium CTV inventory 8PM-11PM PST",
      "min_spend": 10000,
      "cpm_range": {
        "min": 35.00,
        "max": 65.00
      },
      "brief_relevance": "Premium CTV inventory with prime time daypart and California geo-targeting matches sports content request"
    }
  ]
}
```

### 3. Product Catalog Browsing (`list_products`)

Buyers can browse the product catalog with filters:

```json
{
  "brief": "Looking for premium sports inventory",
  "filters": {
    "formats": ["video"],
    "delivery_type": "guaranteed"
  }
}
```

The server returns products based on:
- The authenticated principal's access
- Brief matching (if provided)
- Applied filters

### 4. Custom Product Generation

For unique requirements, servers can generate custom products on-demand:
- Products are marked with `is_custom: true`
- Include `expires_at` to prevent catalog bloat
- Pricing based on the specific requirements

### Off-the-Shelf Products

Publishers may offer standard products that are common across the industry, depending on their type:

1. **Display Products**:
   - Homepage takeover
   - Run of site banner
   - Mobile interstitial
   - Native content units

2. **Video Products**:
   - Pre-roll video
   - Mid-roll video
   - Connected TV spots
   - Outstream video

3. **Audio Products**:
   - Podcast pre-roll
   - Streaming audio spots
   - Voice assistant placements

4. **DOOH Products**:
   - Digital billboards
   - Transit displays
   - Retail screens

### Discovery Best Practices

1. **Use Natural Language Briefs**: Help servers understand campaign intent
2. **Apply Relevant Filters**: Use product field filters effectively
3. **Consider Custom Products**: For unique campaigns that don't match standard inventory

### Example Product

```json
{
  "product_id": "sports_premium",
  "name": "Sports - Premium Inventory",
  "description": "High-impact placements on sports content",
  "formats": [{
    "format_id": "display_leaderboard"
  }],
  "delivery_type": "guaranteed",
  "is_fixed_price": true,
  "cpm": 25.00
}
```

### Discovery to Purchase Flow

```
1. list_products → Find relevant inventory
2. get_avails → Check availability and pricing
3. create_media_buy → Purchase using product_id
4. add_creative_assets → Upload creatives
5. Monitor delivery → Track performance
```
