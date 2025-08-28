---
sidebar_position: 1
title: Glossary
---

# Glossary

## A

**Account Type**  
Classification of MCP session credentials as either "platform" (aggregator) or "customer" (direct advertiser/agency).

**Activation**  
The process of making a signal available for targeting on a specific platform and seat.

**Ad Context Protocol (AdCP)**  
An open standard based on Model Context Protocol (MCP) that enables AI-powered advertising workflows through natural language interfaces.

**Agentic eXecution Engine (AXE)**  
Real-time systems that handle brand safety, frequency capping, first-party data activation, and advanced signal processing for advertising campaigns.

**Signal Discovery**  
The process of finding relevant data signals (audiences, contextual, geographical, temporal) using natural language descriptions.

**Signal ID**  
A unique identifier for a signal within a provider's catalog.

**Signal Type**  
Classification of signals as "marketplace" (third-party), "owned" (first-party), "destination" (bundled with media), "contextual", "geographical", or "temporal".

## C

**CPM (Cost Per Mille)**  
Pricing model based on cost per thousand impressions.

**Customer Account**  
Direct advertiser or agency account with specific seat access and negotiated rates.

## D

**Deployment** (Signals Protocol)  
The availability status of a signal on specific platforms, including activation state and timing.

**Devices** (Signals Protocol)  
Size unit representing unique device identifiers (cookies, mobile IDs) - typically the largest reach metric.

**Device Type** (Media Buy Protocol)  
Targeting dimension for platform types: mobile, desktop, tablet, CTV, audio, DOOH.

**DSP (Demand-Side Platform)**  
Technology platform that allows advertisers to buy advertising inventory programmatically.

## E

**Estimated Activation Time**  
Predicted timeframe for signal deployment, typically 24-48 hours for new activations.

## H

**Households**  
Size unit representing unique household addresses, useful for geographic and family-based targeting.

## I

**Impressions** (Media Buy Protocol)  
The number of times an ad is displayed, used for pricing and delivery tracking.

**Individuals** (Signals Protocol)  
Size unit representing unique people, best for frequency capping and demographic targeting.

**Inventory**  
Available advertising space on websites, apps, or other media properties.

## M

**MCP (Model Context Protocol)**  
The underlying protocol framework that enables AI assistants to interact with external systems.

**Marketplace Signal**  
Third-party signal available for licensing from data providers.

## N

**Natural Language Processing**  
The AI capability that allows audience discovery through conversational descriptions rather than technical parameters.

## O

**Owned Signal**  
First-party signal data belonging to the advertiser or platform.

## P

**Platform Account**  
Master account representing an advertising platform that can syndicate signals to multiple customers.

**Prompt**  
Natural language description used to discover relevant signals (e.g., "high-income sports enthusiasts", "premium automotive content", "users in urban areas during evening hours").

**Provider**  
The company or platform that supplies signal data (e.g., LiveRamp, Experian, Peer39, weather services).

## R

**Relevance Score**  
Numerical rating (0-1) indicating how well a signal matches the discovery prompt.

**Relevance Rationale**  
Human-readable explanation of why an audience received its relevance score.

**Revenue Share**  
Pricing model based on a percentage of media spend rather than fixed CPM.

## S

**Seat**  
A specific advertising account within a platform, typically representing a brand or campaign.

**Segment ID**  
The specific identifier used for signal activation, may differ from signal_id.

**Size Unit** (Signals Protocol)  
The measurement type for signal size: individuals, devices, or households.

## T

**Third-Party Signal**  
Signal data licensed from external providers, also known as marketplace signals.

## U

**Usage Reporting**  
Daily reporting of signal utilization for billing and optimization purposes.

## B

**Budget**  
Total monetary allocation for a media buy, which can be distributed across multiple packages.

## F

**Flight**  
A time-bounded advertising campaign segment, mapped to line items in ad servers.

## H

**Households** (Signals Protocol)  
Size unit representing unique household addresses, useful for geographic and family-based targeting.

**Human-in-the-Loop (HITL)** (Media Buy Protocol)  
Protocol feature allowing publishers to require manual approval for operations.

## L

**Line Item**  
The basic unit of inventory in ad servers like Google Ad Manager, represented as packages in AdCP.

## M

**MCP (Model Context Protocol)**  
The underlying protocol framework that enables AI assistants to interact with external systems.

**Marketplace Signal**  
Third-party signal available for licensing from data providers.

**Media Buy**  
A complete advertising campaign containing packages, budget, targeting, and creative assets.

## P

**Package**  
A specific advertising product within a media buy, representing a flight or line item with its own pricing and targeting.

**Principal**  
An authenticated entity (advertiser, agency, or brand) with unique access credentials and platform mappings.

**Product**  
Advertising inventory available for purchase, discovered through natural language queries.

## Acronyms

- **AdCP**: Ad Context Protocol
- **API**: Application Programming Interface
- **AXE**: Agentic eXecution Engine
- **CPM**: Cost Per Mille (thousand)
- **DSP**: Demand-Side Platform
- **DMP**: Data Management Platform
- **MCP**: Model Context Protocol
- **PII**: Personally Identifiable Information
- **RTB**: Real-Time Bidding
- **SSP**: Supply-Side Platform
- **TTD**: The Trade Desk
- **UTC**: Coordinated Universal Time

## Units and Measurements

**Time Formats**
- All timestamps use ISO 8601 format (e.g., "2025-01-20T14:30:00Z")
- Dates use YYYY-MM-DD format
- Activation times expressed as human-readable estimates ("24-48 hours")

**Currency**
- All pricing in specified currency (typically USD)
- CPM expressed as cost per 1,000 impressions
- Revenue share expressed as decimal (0.15 = 15%)

**Size Reporting** (Signals Protocol)
- Counts expressed as integers
- Units clearly specified (individuals/devices/households)
- Dated with "as_of" timestamp for freshness

**Impression Reporting** (Media Buy Protocol)
- Delivery counts by package
- Pacing metrics for optimization
- Dimensional breakdowns available

## Error Codes Reference

Common error codes across all AdCP implementations:

- `SEGMENT_NOT_FOUND`: Invalid or expired segment ID
- `ACTIVATION_FAILED`: Unable to complete activation process
- `ALREADY_ACTIVATED`: Signal already active for platform/seat
- `DEPLOYMENT_UNAUTHORIZED`: Insufficient permissions for platform/seat
- `BUDGET_EXCEEDED`: Operation would exceed allocated budget
- `CREATIVE_REJECTED`: Creative asset failed platform review
- `INVALID_PRICING_MODEL`: Requested pricing model unavailable
- `RATE_LIMIT_EXCEEDED`: Too many requests in time window
- `AUTHENTICATION_FAILED`: Invalid or expired credentials
- `VALIDATION_ERROR`: Request format or parameter errors