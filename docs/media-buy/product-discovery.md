---
title: Product Discovery
---

# Product Discovery

Product discovery is the foundation of the Media Buy Protocol, enabling AI agents to find relevant advertising inventory using natural language. This page provides a conceptual overview of how product discovery works in AdCP.

## Overview

Product discovery in AdCP follows a natural language-first approach, allowing buyers to describe their campaign goals in plain English rather than navigating complex product catalogs. The system uses AI to match these briefs against available inventory.

## Key Concepts

### Natural Language Briefs

Instead of requiring buyers to know specific product codes or navigate hierarchical catalogs, AdCP accepts natural language descriptions:

- "I want to reach pet owners in California with video ads during prime time"
- "Looking for premium sports inventory"
- "Low budget display campaign for millennials"

For comprehensive guidance on brief structure and requirements, see [Brief Expectations](./brief-expectations).

### Format-Aware Discovery

Products are matched not just by audience and targeting, but also by creative format compatibility. This ensures advertisers only see inventory that matches their available creative assets.

### Principal-Specific Catalogs

Each principal (advertiser or agency) may have access to different products based on:
- Negotiated deals and rates
- Private marketplace access
- Custom products created for their needs
- Account-level permissions

### Custom Product Generation

For unique requirements that don't match existing inventory, the system can generate custom products with specific targeting, formats, and pricing tailored to the brief.

## Discovery Tasks

AdCP provides two main tasks for product discovery:

### [`list_creative_formats`](./tasks/list_creative_formats)

Discover all supported creative formats in the system. This helps advertisers understand what types of creatives they need before searching for products.

### [`get_products`](./tasks/get_products)

The main discovery task that accepts natural language briefs and returns matching products. See the task documentation for detailed implementation guidance and examples.

## Discovery Flow

1. **Format Discovery**: Optionally start by understanding available creative formats
2. **Product Search**: Use natural language or filters to find relevant products
3. **Product Review**: Evaluate pricing, targeting, and requirements
4. **Selection**: Choose products that best match campaign goals
5. **Media Buy Creation**: Proceed to create a media buy with selected products

## Best Practices

- **Be Specific**: More detailed briefs lead to better product matches (see [Brief Expectations](./brief-expectations) for guidance)
- **Consider Formats First**: Know your creative capabilities before searching
- **Review Multiple Options**: The system may return several matching products
- **Check Custom Options**: For unique needs, custom products may be available
- **Include Required Information**: Always provide a clear `promoted_offering` description

## Related Documentation

- [Brief Expectations](./brief-expectations) - Comprehensive guide to brief structure and requirements
- [Media Products](./media-products) - Understanding product types and attributes
- [Creative Formats](./creative-formats) - Detailed creative specifications
- [`get_products` Task](./tasks/get_products) - Implementation guide and API reference
- [`create_media_buy` Task](./tasks/create_media_buy) - Next step after discovery