# Agentic Digital Content Protocol (ADCP) Specification V2.3

**Version**: 2.3  
**Status**: Implemented

## Overview

This document provides the formal specification for the Agentic Digital Content Protocol (ADCP) V2.3. The protocol is designed to be a simple, expressive, and AI-first standard for the entire media buying lifecycle.

The specification is broken down into a series of articles, each covering a logical phase of the protocol.

## Specification Documents

1.  **[Media Products & Discovery](./01-media-products.md)**
    -   Defines the `Product` model.
    -   Describes the AI-driven `list_products` discovery tool.

2.  **[Creative Lifecycle](./02-creative-lifecycle.md)**
    -   Defines the `Creative` and `CreativeStatus` models.
    -   Specifies the `submit_creatives`, `check_creative_status`, and `adapt_creative` tools.

3.  **[Media Buys](./03-media-buys.md)**
    -   Defines the `CreateMediaBuyRequest` model.
    -   Specifies the `create_media_buy`, `assign_creatives`, and `update_media_buy` tools.

4.  **[Targeting](./04-targeting.md)**
    -   Defines the `Targeting` model.
    -   Explains the layered application of base templates and overlays.

5.  **[Reporting & Optimization](./05-reporting-and-optimization.md)**
    -   Specifies the `get_media_buy_delivery` tool for monitoring performance.
    -   Defines the `update_performance_index` tool for providing optimization feedback.

## Supporting Documents

- **[Creative Formats](./creative-formats.md)**: A detailed guide to the standard and custom creative formats supported by the protocol.
