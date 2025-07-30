---
sidebar_position: 1
title: Getting Started
---

# Getting Started with Ad Context Protocol

Welcome to the Ad Context Protocol (AdCP) documentation. AdCP enables AI assistants to interact with advertising platforms through standardized interfaces.

## What is Ad Context Protocol?

Ad Context Protocol is an open standard based on the Model Context Protocol (MCP) that allows:

- **Natural Language Interaction**: Describe what you want in plain English
- **Platform Agnostic**: Works with any compatible advertising platform
- **AI-Powered**: Designed for integration with AI assistants like Claude, GPT, and others

## Protocol Architecture

AdCP operates at multiple layers, providing a clean separation between the business roles, orchestration layer, and technical execution:

![Layers of the Stack](./layers-of-the-stack.png)

## The AdCP Ecosystem Layers

### Top Layer: Business Principals

#### Buying Principal (Left)
The demand side of advertising, including:
- **Advertisers**: Brands with products/services to promote
- **Agencies**: Acting on behalf of advertisers
- **Retail Media Networks**: Retailers monetizing their audiences
- **Curators**: Packaging inventory and data for specific use cases

#### Media Seller (Right)
The supply side of advertising, including:
- **Publishers**: Content creators with audience reach
- **Sales Houses**: Representing multiple publishers
- **Rep Firms**: Specialized sales representation
- **SSPs**: Supply-side platforms aggregating inventory
- **Ad Networks**: Aggregating and reselling inventory

These parties exchange impressions and money through the orchestration layer below.

### Middle Layer: Orchestration

#### Media Orchestration Platform (Left)
Platforms that evaluate sellers and audiences, and execute buying strategies:
- **Examples**: Scope3, custom orchestration solutions
- **Function**: Strategy execution, seller evaluation, optimization
- **Integration**: Uses MCP to communicate with Sales Agents

#### Sales Agent (Right)
MCP servers that provide:
- **Product Discovery**: Natural language inventory search
- **Audience Discovery**: Finding relevant audiences
- **Media Execution**: Creating and managing campaigns
- **Integration**: Exposes publisher capabilities via MCP

### Bottom Layer: Technical Execution

#### Agent Execution Environment (Left)
Real-time systems for:
- **Brand Safety**: Ensuring appropriate ad placement
- **Frequency Capping**: Managing exposure limits
- **First-Party Data**: Activating advertiser data
- **Integration**: Connects via key-value pairs or RTB protocols

#### Publisher Ad Tech (Right)
The technical infrastructure that:
- **Selects Impressions**: Decides which ad to serve
- **Delivery Method**: Direct campaigns or programmatic (RTB)
- **Examples**: Google Ad Manager, Kevel, proprietary systems

## How AdCP Protocols Work Together

Each AdCP protocol operates within this ecosystem:

### 🎯 Audience Activation Protocol
- **Scope**: Works with **audience platforms** to discover and activate audiences directly on **decisioning platforms**
- **Integration**: Direct integration between audience agents and decisioning platforms (DSPs, injective platforms)
- **Workflow**: Find audiences → Direct activation on target platform → Ready for campaign use

### 📍 Curation Protocol (Coming Q2 2025)
- **Scope**: Works with **decisioning platforms** and **supply-side platforms**
- **Integration**: Curates inventory that will be targeted with activated audiences
- **Workflow**: Define requirements → Find inventory → Package with audiences

### 💰 Media Buy Protocol
- **Scope**: Works primarily with **decisioning platforms** (DSPs, injective platforms)
- **Integration**: Executes campaigns using curated inventory and activated audiences
- **Workflow**: Set objectives → Execute buys → Optimize performance

## Quick Example

Instead of navigating multiple platforms, you can now say:

> "Find audiences of premium sports enthusiasts who would be interested in high-end running shoes, and activate them on Scope3."

The AI assistant will:
1. Search for relevant audiences across connected platforms
2. Show you options with transparent pricing
3. Activate your chosen audiences for use on decisioning platforms

## Available Protocols

### 🎯 [Audience Activation Protocol](./audience/overview)
**Status**: RFC/v0.1

Discover and activate marketing audiences using natural language.

### 📍 Curation Protocol
**Status**: Coming Q2 2025

Curate media inventory based on context and brand safety.

### 💰 [Media Buy Protocol](./media-buy)
**Status**: RFC/v0.1

Execute and optimize media buys programmatically.

## Reference Implementations

- [Audience Agent](https://github.com/adcontextprotocol/audience-agent)
- [Sales Agent](https://github.com/adcontextprotocol/salesagent)

## For Platform Providers

If you operate an audience platform, DSP, or ad tech solution:

1. [Review the Protocol Specifications](./audience/specification)

## For Advertisers & Agencies

If you want to use AdCP with your AI assistant:

1. Check if your platforms support AdCP
2. Configure your AI assistant with AdCP-enabled platforms
3. Start using natural language for your campaigns

## Next Steps

- **Platform Providers**: Start with the [Audience Protocol Specification](./audience/specification)
- **Everyone**: Join the [community discussion](https://github.com/adcontextprotocol/adcp/discussions)

## Need Help?

- 📖 Browse the documentation
- 💬 Ask in [GitHub Discussions](https://github.com/adcontextprotocol/adcp/discussions)
- 📧 Email: support@adcontextprotocol.org
