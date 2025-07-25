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

## Ad Tech Ecosystem Architecture

The advertising technology landscape consists of two fundamental types of platforms that AdCP connects:

### Decisioning Platforms
Platforms where audiences, targeting, and optimization happen, generating decisions such as bids, PMP creation, or buy execution:

- **DSPs (Demand-Side Platforms)**: Where advertisers bid on inventory (The Trade Desk, Google DV360)
- **SSPs (Supply-Side Platforms)**: Where publishers offer inventory
- **Ad Servers**: Where creative decisioning and serving occurs  
- **Injective Platforms**: Like Scope3, where campaigns are planned and executed

### Audience Platforms
Platforms that have information about audiences (people, households, devices) and can deliver those audiences to decisioning platforms where they become transacted upon:

- **Data Providers**: LiveRamp, Experian - license audience segments
- **Data Management Platforms (DMPs)**: Aggregate and organize audience data
- **Customer Data Platforms (CDPs)**: Unify customer data across touchpoints
- **Identity Resolution Services**: Link devices and identities across platforms

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

### 💰 [Media Buy Protocol](./media-buy/overview)
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
