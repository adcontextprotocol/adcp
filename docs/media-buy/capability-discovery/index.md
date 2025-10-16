---
title: Overview
description: Understanding creative formats and property authorization in AdCP - the foundation for effective advertising workflows.
keywords: [capability discovery, creative formats, authorized properties, format specifications, property authorization]
sidebar_position: 2
---

# Overview

Before you can effectively buy advertising through AdCP, you need to understand two fundamental capabilities: **what creative formats are supported** and **which properties sales agents are authorized to represent**. This section covers the tools and concepts that form the foundation of AdCP's advertising ecosystem.

## What You'll Learn

### [Authorized Properties](./authorized-properties) 🔐
Learn how AdCP prevents unauthorized resale and ensures sales agents are legitimate. Understand:

- The problem of unauthorized resale in digital advertising
- How publishers authorize sales agents via `adagents.json`
- How to validate sales agent authorization before purchasing
- Property tags and large-scale authorization management


## Foundation Tasks

These capability discovery tasks provide the reference data needed for effective AdCP workflows:

### [`list_creative_formats`](../task-reference/list_creative_formats)
Discover all supported creative formats with detailed specifications including dimensions, file types, duration limits, and technical requirements.

### [`list_authorized_properties`](../task-reference/list_authorized_properties)  
Get all properties a sales agent is authorized to represent, including property tags for efficient organization and authorization validation data.

## Integration Pattern

Capability discovery typically happens early in your AdCP workflow:

1. **Understand Formats**: Call [`list_creative_formats`](../task-reference/list_creative_formats) to learn supported creative types
2. **Validate Authorization**: Use [`list_authorized_properties`](../task-reference/list_authorized_properties) to verify sales agent legitimacy
3. **Discover Products**: Search for advertising inventory with [`get_products`](../task-reference/get_products)
4. **Plan Creatives**: Match discovered products to available formats for production planning
5. **Execute Campaigns**: Create media buys with confidence in format compatibility and authorization

## Why This Matters

### Creative Formats
- **Production Planning**: Know requirements before creating assets
- **Creative Agents**: Leverage AI-powered agents to build and validate creatives
- **Platform Compatibility**: Ensure creatives work across advertising platforms
- **Cost Efficiency**: Avoid recreating assets due to specification mismatches
- **Quality Assurance**: Meet technical standards for optimal performance
- **Preview Capabilities**: Test creative rendering before campaign launch

### Authorized Properties  
- **Fraud Prevention**: Avoid unauthorized sellers and inventory fraud
- **Brand Safety**: Ensure you're buying from legitimate property owners
- **Legal Compliance**: Maintain clear audit trails of authorized transactions
- **Trust Building**: Create confidence in the advertising supply chain

Together, these capabilities provide the foundation for safe, efficient, and effective advertising through AdCP.

## Related Documentation

- **[Task Reference](../task-reference/)** - Complete API documentation
- **[Product Discovery](../product-discovery/)** - Finding advertising inventory
- **[Creatives](../creatives/)** - Creative asset management
- **[Creative Protocol](../../creative/)** - Creative agents and manifests
- **[Creative Channel Guides](../../creative/channels/video)** - Format examples and patterns
- **[Creative Manifests](../../creative/creative-manifests.md)** - Understanding creative specifications
- **[AdAgents Specification](./adagents)** - Technical authorization details