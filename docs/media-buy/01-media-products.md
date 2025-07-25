# 1. Media Products & Discovery

The foundation of the ADCP V2.3 is the **Product**. A Product is a clearly defined, sellable unit of advertising inventory. This document outlines the structure of a Product and the AI-driven discovery process.

## The Product Model

A `Product` is a structured object that contains all the information a buyer needs to understand what they are purchasing.

- **`product_id`**: A unique identifier for the product.
- **`name`**: A human-readable name (e.g., "Premium In-Stream Video (Sports)").
- **`description`**: A detailed description of the inventory.
- **`formats`**: A list of creative formats the product supports. See the [Creative Formats](./creative-formats.md) guide for details.
- **`cpm`**: The base Cost Per Mille for the product.
- **`targeting_template`**: A `Targeting` object that defines the base audience and delivery constraints for this product. See the [Targeting](./04-targeting.md) guide for details.

### Example Product

```json
{
  "product_id": "prod_video_instream_sports",
  "name": "Premium In-Stream Video (Sports)",
  "description": "High-quality, unskippable video ads placed before sports content.",
  "formats": [
    {
      "format_id": "video_standard_1080p",
      "name": "Standard HD Video",
      "type": "video",
      "description": "Standard 1080p video ad",
      "specs": {"resolution": "1920x1080", "duration": "30s"},
      "delivery_options": {"vast": {"supported": true, "versions": ["4.2"]}}
    }
  ],
  "cpm": 35.50,
  "targeting_template": {
    "geography": ["USA"],
    "content_categories_include": ["sports", "mens-lifestyle"]
  }
}
```

## The Discovery Process

Discovery in V2.3 is handled by the `list_products` tool, which uses a natural language brief to find the most suitable products.

### The Brief

The client provides a `brief`, a simple string that describes the campaign goals. A good brief includes information about the target audience, desired content, budget, and flight dates.

**Example Brief:**
> "I want to spend around $500,000 over the next three months to advertise my new brand of premium cat food, 'Purrfect Choice'. My target audience is cat lovers in the USA, primarily on weekends. I want to use a mix of high-impact video and standard display ads."

### The `list_products` Tool

The server receives the brief and is expected to use an AI model to analyze it against its product catalog. The tool's logic should compare the user's intent with the `description`, `formats`, and `targeting_template` of each product to find the best matches.

The tool then returns a `ListProductsResponse`, which contains a list of the full `Product` objects that the AI has determined are a good fit for the brief. This list of recommended products forms the basis for the media buy.
