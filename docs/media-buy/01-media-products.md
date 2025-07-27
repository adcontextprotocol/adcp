---
title: Media Products & Discovery
---

# Media Products & Discovery

A **Product** is the core sellable unit in AdCP. This document details the Product model, including its pricing and delivery types, and the process for discovering standard, principal-specific, and custom-generated products.

## The Product Model

- `product_id` (string, required)
- `name` (string, required)
- `description` (string, required)
- `formats` (list[Format], required): See [Creative Formats](creative-formats.md).
- `targeting_template` (Targeting, required): See [Targeting](04-targeting.md).
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
- **Principal-Specific Products**: If a `principal_id` is sent in the `list_products` request, the server can return products reserved for or negotiated with that specific client.
- **Custom Products**: The server can generate new, temporary products in response to a `brief`, returning them with `is_custom: true` and an `expires_at` timestamp. This allows for maximum flexibility without cluttering the main catalog.
