# 4. Targeting

Targeting in ADCP V2.3 is designed to be both powerful and human-readable. It uses a layered approach, combining a base template from a `Product` with a specific `Targeting Overlay` from a `Media Buy`.

## The Targeting Model

The `Targeting` object is a unified model that captures all targeting criteria for a campaign.

- **`geography`**: A list of targeted geographies (e.g., `["USA", "GB-LND"]`). Uses ISO 3166-1 alpha-2 for countries and ISO 3166-2 for subdivisions.
- **`exclude_geography`**: A list of geographies to exclude.
- **`day_parts`**: Human-readable strings for dayparting (e.g., `["weekdays-daytime", "weekends-evening"]`). The publisher defines which strings they support.
- **`technology`**: Technology-based targeting (e.g., `["device-mobile", "browser-chrome"]`).
- **`content_categories_include`**: A list of content categories to target (e.g., `["news", "sports"]`). Based on IAB Content Taxonomy.
- **`content_categories_exclude`**: A list of content categories to avoid.

### Example Targeting Object
```json
{
  "geography": ["USA-CA", "USA-NY"],
  "exclude_geography": ["USA-FL"],
  "day_parts": ["weekdays-daytime"],
  "technology": ["device-mobile"],
  "content_categories_include": ["technology", "business"],
  "content_categories_exclude": ["politics"]
}
```

## Layered Application

Targeting is applied in two layers:

1.  **Base Template (`Product.targeting_template`)**: Every product in the catalog has a base `Targeting` object that defines its core audience. For example, a "Premium Sports Video" product would have `content_categories_include: ["sports"]`.

2.  **Targeting Overlay (`CreateMediaBuyRequest.targeting_overlay`)**: When a media buy is created, the client provides a `targeting_overlay`. This overlay **refines** the base templates of all products included in the buy.

### How Overlays Work

The overlay does not replace the base template; it adds to it. The final targeting for a given product is the **combination** of its base template and the media buy's overlay.

- **Lists are combined**: `geography`, `technology`, etc., are merged.
- **Exclusions are added**: All exclusions from both the template and the overlay are applied.

**Example:**

1.  **Product Template:**
    ```json
    { "content_categories_include": ["sports"] }
    ```
2.  **Media Buy Overlay:**
    ```json
    { "geography": ["USA"], "content_categories_include": ["mens-lifestyle"] }
    ```
3.  **Final, Effective Targeting:**
    ```json
    {
      "geography": ["USA"],
      "content_categories_include": ["sports", "mens-lifestyle"]
    }
    ```

This layered approach allows publishers to create well-defined products while giving buyers the flexibility to tailor their campaigns to specific needs.
