---
title: Overview
---

# Advertising Context Protocol (AdCP) Overview

The Advertising Context Protocol (AdCP) provides a simple, expressive, and AI-first standard for the entire media buying lifecycle. It is designed to be language-agnostic and flexible, guiding any implementation of a sales agent server that exposes publisher inventory to AI-driven buyers.

## Key Design Principles

1. **MCP-Based Interface**: Built on Model Context Protocol (MCP) for standardized AI agent interaction, not REST APIs.

2. **Asynchronous by Design**: Operations may take seconds to days to complete. The protocol embraces pending states as normal workflow elements.

3. **Human-in-the-Loop**: Publishers can require manual approval for any operation. The protocol includes comprehensive task management for human intervention.

4. **Multi-Platform Abstraction**: A unified interface that works across Google Ad Manager, Kevel, Triton Digital, and more.

5. **AI-Optimized**: Designed for AI agents to discover, negotiate, and optimize media buys programmatically.

6. **Multi-Tenant Architecture**: Database-backed tenant isolation supporting multiple publishers on a single deployment.

## Key Features

- **Advanced Targeting System**: Two-tier targeting with overlay (principal-accessible) and managed-only (internal) dimensions
- **Creative Management**: Auto-approval workflows, creative groups, and admin review queues
- **AEE Integration**: Built-in support for Ad Effectiveness Engine signals via key-value targeting
- **Security Enhancements**: Comprehensive audit logging, principal context tracking, and adapter security boundaries
- **Production Features**: PostgreSQL support, Docker deployment, health monitoring, and Admin UI
- **Human Task Management**: Complete workflow for manual approval with AI verification of task completion

## Documentation Structure

### Core Concepts
Foundational elements of the Advertising Context Protocol:

- **[Media Products & Discovery](media-products.md)** - Learn how advertising inventory is discovered and selected through natural language
- **[Media Buys](media-buys.md)** - Understand how campaigns are created and managed across platforms
- **[Dimensions](dimensions.md)** - Explore the unified system for categorizing products, targeting, and reporting
- **[Targeting](targeting.md)** - Master the layered targeting approach using dimensional attributes

### Creatives
Managing creative assets throughout their lifecycle:

- **[Creative Lifecycle](creative-lifecycle.md)** - Submit, track, and adapt creative assets
- **[Creative Formats](creative-formats.md)** - Detailed specifications for supported creative types

### Operations
Running successful campaigns:

- **[Media Buy Lifecycle](media-buy-lifecycle.md)** - End-to-end campaign workflow and state management
- **[Reporting & Optimization](reporting-and-optimization.md)** - Monitor delivery and optimize performance
- **[Principals & Security](principals-and-security.md)** - Multi-tenant security model and access control

### Technical Reference
Detailed implementation guidance:

- **[API Reference](api-reference.md)** - Complete tool documentation with examples
- **[Design Decisions](design-decisions.md)** - Architectural choices and rationale

## Getting Started

1. **Understand the Basics**: Start with [Media Products](media-products.md) to learn how inventory discovery works
2. **Learn the Workflow**: Follow the [Media Buy Lifecycle](media-buy-lifecycle.md) for the complete process
3. **Implement**: Use the [API Reference](api-reference.md) for technical details
4. **Optimize**: Apply [Reporting & Optimization](reporting-and-optimization.md) techniques
