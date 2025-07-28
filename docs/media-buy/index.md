---
title: Overview
---

# AdCP:Buy Overview

**Version**: 2.3 (Revised)

The Advertising Context Protocol (AdCP) provides a simple, expressive, and AI-first standard for the entire media buying lifecycle. It is designed to be language-agnostic and flexible, guiding any implementation of a buy-side server.

## Key Design Principles

1. **Asynchronous by Design**: Operations may take seconds to days to complete. The protocol embraces pending states as normal workflow elements.

2. **Human-in-the-Loop**: Publishers can require manual approval for any operation. The protocol includes comprehensive task management for human intervention.

3. **Multi-Platform Abstraction**: A unified interface that works across Google Ad Manager, Kevel, Triton Digital, and more.

4. **AI-Optimized**: Designed for AI agents to discover, negotiate, and optimize media buys programmatically.

This specification is broken down into a series of articles, each covering a logical phase of the protocol.

## Specification Documents

1.  **[Media Products](media-products.md)**
    -   Defines the `Product` model, including custom and principal-specific products.
    -   Describes the AI-driven discovery process.

2.  **[Creative Lifecycle](creative-lifecycle.md)**
    -   Details the creative submission, approval, and adaptation workflow.

3.  **[Media Buys](media-buys.md)**
    -   Specifies the creation and in-flight updating of media buys.

4.  **[Dimensions](dimensions.md)**
    -   Unified dimension system for products, targeting, and reporting.

5.  **[Targeting](targeting.md)**
    -   Explains the layered application of targeting using dimensions.

6.  **[Reporting & Optimization](reporting-and-optimization.md)**
    -   Covers delivery monitoring and the performance feedback loop.

7.  **[Principals & Security](principals-and-security.md)**
    -   Explains the data isolation model and platform mappings.

8.  **[API Reference](api-reference.md)**
    -   Complete API documentation with request/response examples.

9.  **[Design Decisions](design-decisions.md)**
    -   Key architectural choices and industry questions.

10. **[Media Buy Lifecycle](media-buy-lifecycle.md)**
    -   End-to-end lifecycle and update management.

11. **[Orchestrator Design Guide](orchestrator-design.md)**
    -   Requirements and best practices for implementing orchestrators.

## Supporting Documents

- **[Creative Formats](creative-formats.md)**: A detailed guide to creative formats.
