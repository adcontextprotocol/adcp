# AdCP:Buy Overview

**Version**: 2.3 (Revised)

The Advertising Context Protocol (AdCP) provides a simple, expressive, and AI-first standard for the entire media buying lifecycle. It is designed to be language-agnostic and flexible, guiding any implementation of a buy-side server.

This specification is broken down into a series of articles, each covering a logical phase of the protocol.

## Specification Documents

1.  **[Media Products](01-media-products.md)**
    -   Defines the `Product` model, including custom and principal-specific products.
    -   Describes the AI-driven discovery process.

2.  **[Creative Lifecycle](02-creative-lifecycle.md)**
    -   Details the creative submission, approval, and adaptation workflow.

3.  **[Media Buys](03-media-buys.md)**
    -   Specifies the creation and in-flight updating of media buys.

4.  **[Targeting](04-targeting.md)**
    -   Explains the layered application of targeting templates and overlays.

5.  **[Reporting & Optimization](05-reporting-and-optimization.md)**
    -   Covers delivery monitoring and the performance feedback loop.

## Supporting Documents

- **[Creative Formats](creative-formats.md)**: A detailed guide to creative formats.
- **[Reference Implementation](https://github.com/adcontextprotocol/salesagent)**: A buy-side server implementation in Python.
