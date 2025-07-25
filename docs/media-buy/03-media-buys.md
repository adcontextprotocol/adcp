# 3. Media Buys

The Media Buy represents the client's commitment to purchase inventory.

## Creating a Media Buy

The `create_media_buy` tool creates the buy.

- `product_ids` (list[string], required)
- `flight_start_date` / `flight_end_date` (date, required)
- `total_budget` (float, required)
- `targeting_overlay` (Targeting, required)
- `po_number` (string, optional)
- `pacing` (string, optional): "even" (default), "asap", or "daily_budget".
- `daily_budget` (float, optional): Required if `pacing` is "daily_budget".
- `creatives` (list[Creative], optional): Creatives to submit immediately.

**Example:** A client wants to launch a $50,000 campaign as quickly as possible.
```json
{
  "product_ids": ["prod_video_takeover", "prod_display_ros"],
  "flight_start_date": "2025-08-01",
  "flight_end_date": "2025-08-15",
  "total_budget": 50000.00,
  "targeting_overlay": { "geography": ["USA-CA"] },
  "pacing": "asap"
}
```

## Updating a Media Buy

The `update_media_buy` tool is a single, powerful tool for all in-flight modifications.

- `media_buy_id` (string, required)
- `new_total_budget` (float, optional)
- `new_targeting_overlay` (Targeting, optional)
- `creative_assignments` (dict, optional): Assigns creatives to products.

### Consolidating Creative Assignment

Instead of a separate tool, creative assignment is handled within the update call. This allows for a single, atomic update.

**Example:** A campaign is performing well, so the client wants to increase the budget and assign a new, high-performing creative.
```json
{
  "media_buy_id": "mb_12345",
  "new_total_budget": 75000.00,
  "creative_assignments": {
    "prod_video_takeover": [
      "cr_original_promo_30s",
      "cr_new_high_perf_15s"
    ]
  }
}
```
This design is more efficient, reducing the number of API calls required to manage a campaign.