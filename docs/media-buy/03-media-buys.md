# 3. Media Buys

The **Media Buy** is the central object that represents a purchase. This document covers the creation and in-flight management of a media buy.

## Creating a Media Buy (`create_media_buy`)

A media buy is created by specifying which products to purchase and providing the necessary campaign details.

- **Request**: `CreateMediaBuyRequest`
  - **`product_ids`**: A list of products recommended by the `list_products` tool.
  - **`po_number`**: The purchase order number for this buy.
  - **`flight_start_date` / `flight_end_date`**: The campaign duration.
  - **`total_budget`**: The total budget for the entire media buy.
  - **`targeting_overlay`**: A `Targeting` object that refines the base targeting of the selected products. See the [Targeting](./04-targeting.md) guide.
  - **`initial_creatives`**: An optional list of `Creative` objects to submit immediately.

- **Response**: `CreateMediaBuyResponse`
  - **`media_buy_id`**: The unique identifier for this media buy, which is used in all subsequent lifecycle calls.
  - **`status`**: The initial status of the buy (e.g., "created").

## In-Flight Management

Once a media buy is created, it can be updated and managed using its `media_buy_id`.

### Assigning Creatives (`assign_creatives`)

This tool maps approved creatives to specific products within the buy. This is the final step that makes a creative eligible to serve in a specific placement. A single creative can be assigned to multiple products if it is compatible with their formats.

- **Request**: `AssignCreativesRequest`
  - **`media_buy_id`**: The ID of the buy to update.
  - **`assignments`**: A dictionary where keys are `product_id`s and values are lists of `creative_id`s.

  **Example `assignments`:**
  ```json
  {
    "prod_video_instream_sports": [
      "cr_video_catfood_promo_30s",
      "cr_video_catfood_promo_15s"
    ],
    "prod_display_banner_news": [
      "cr_banner_catfood_300x250"
    ]
  }
  ```

### Updating the Buy (`update_media_buy`)

This tool allows for modifying the core parameters of a live media buy.

- **Request**: `UpdateMediaBuyRequest`
  - **`media_buy_id`**: The ID of the buy to update.
  - **`new_total_budget`**: (Optional) A new total budget for the campaign.
  - **`new_targeting_overlay`**: (Optional) A new `Targeting` object that will replace the previous overlay.

This enables clients to react to campaign performance by reallocating budget or refining the audience.
