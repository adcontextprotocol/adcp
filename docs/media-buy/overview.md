# ADCP V2.3 Media Buying Overview

## Objectives

The Agentic Digital Content Protocol (ADCP) V2.3 provides a streamlined, AI-first mechanism for orchestrators to facilitate and manage the **entire lifecycle** of a media buy. It is designed to be simple to implement while providing the necessary expressiveness for modern media buys, from initial discovery to in-flight optimization.

This document provides a high-level overview of the protocol. For detailed information on each phase, please see the full specification documents.

## Protocol Flow

The protocol is broken down into a series of logical phases, each with its own set of tools and data models.

1.  **[Media Products & Discovery](./01-media-products.md)**
    -   Define a catalog of sellable **Products**.
    -   Use a natural language **brief** with the `list_products` tool for AI-powered discovery.

2.  **[Creative Lifecycle](./02-creative-lifecycle.md)**
    -   Submit creatives for approval using `submit_creatives`.
    -   Check on the approval process with `check_creative_status`.
    -   Request new creative variations with `adapt_creative`.

3.  **[Media Buys](./03-media-buys.md)**
    -   Purchase products with `create_media_buy`.
    -   Activate creatives by mapping them to products with `assign_creatives`.
    -   Modify live campaigns with `update_media_buy`.

4.  **[Targeting](./04-targeting.md)**
    -   Understand the layered approach of combining a base `targeting_template` with a media buy's `targeting_overlay`.

5.  **[Reporting & Optimization](./05-reporting-and-optimization.md)**
    -   Monitor campaign delivery with `get_media_buy_delivery`.
    -   Provide performance feedback for AI-driven optimization using `update_performance_index`.

## Next Steps

- Read the full [Protocol Specification](./specification.md)
- Review the [Creative Formats](./creative-formats.md)
- See the [reference implementation](https://github.com/google/gemini-adcp-buy-server)
