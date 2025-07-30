---
title: Media Products
---

# Media Products

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and how products are discovered and structured in the system.

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
- **Principal-Specific Products**: Products reserved for or negotiated with specific clients
- **Custom Products**: Dynamically generated products with `is_custom: true` and an `expires_at` timestamp

## Product Examples

### Standard Product
```json
{
  "product_id": "connected_tv_prime",
  "name": "Connected TV - Prime Time",
  "description": "Premium CTV inventory 8PM-11PM",
  "formats": [{"format_id": "video_standard", "name": "Standard Video"}],
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
  "formats": [{"format_id": "display_300x250", "name": "Medium Rectangle"}],
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

## Integration with Discovery

Products are discovered through the [Product Discovery](./product-discovery.md) process, which uses natural language to match campaign briefs with available inventory. Once products are identified, they can be purchased via `create_media_buy`.

## See Also

- [Product Discovery](./product-discovery.md) - How to discover products using natural language
- [Media Buys](./media-buys.md) - How to purchase products
- [Targeting](./targeting.md) - Detailed targeting options
- [Creative Formats](./creative-formats.md) - Supported creative specifications
